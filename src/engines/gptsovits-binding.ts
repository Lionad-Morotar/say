import { EngineError } from "../errors.ts";
import type { DaemonProcess, Host } from "../host.ts";
import { decodePcm, encodeRequest, parseLine } from "./gptsovits-protocol.ts";

/** say-lab 引擎安装面（路径判据与 scripts/lib/engine-status.mjs 同构） */
export interface GptsovitsLabSpec {
  /** say-lab 引擎目录（~/.local/share/say-lab/gptsovits） */
  labDir: string;
  /** GPT-SoVITS 仓库根（labDir/GPT-SoVITS），shim 的 --repo 参数与 cwd */
  repoDir: string;
  /** venv 解释器（labDir/venv/bin/python） */
  pythonPath: string;
  /** shim 脚本绝对路径（say 仓 scripts/shims/gptsovits-shim.py） */
  shimPath: string;
}

export interface GptsovitsSynthRequest {
  text: string;
  refAudioPath: string;
  promptText: string;
  promptLang: string;
  textLang: string;
  speedFactor: number;
}

export interface GptsovitsSynthResult {
  samples: Float32Array;
  sampleRate: number;
}

/** 合成函数类型：适配器只认这个面，测试注入 fake 而不触真实 shim 进程 */
export type GptsovitsSynth = (req: GptsovitsSynthRequest) => Promise<GptsovitsSynthResult>;

/** 冷启动 ~12s 是调研实测常态；120s 给首跑 JIT 与慢盘余量 */
const READY_TIMEOUT_MS = 120_000;
/** 单块合成热态秒级、冷态秒级×10 的量级；180s 覆盖 400 token 上限块在最慢机器上的余量 */
const SYNTH_TIMEOUT_MS = 180_000;

function timeoutError(kind: string, ms: number): EngineError {
  return new EngineError(`GPT-SoVITS ${kind}超时（>${Math.round(ms / 1000)}s）：进程无响应，已终止`);
}

/**
 * 管道流的活动性开关：真进程的 stdio 是 socket（有 ref/unref），fake 的 PassThrough 没有——
 * 缺方法静默跳过。idle 态 unref 让 CLI 在合成完成后自然退出（子进程不拖事件循环），
 * 在途请求期 ref 保住「合成中进程不被提前回收」。
 */
function setStreamActive(stream: unknown, active: boolean): void {
  const refable = stream as { ref?: () => void; unref?: () => void };
  if (active) refable.ref?.();
  else refable.unref?.();
}

function setSessionActive(proc: DaemonProcess, active: boolean): void {
  setStreamActive(proc.stdin, active);
  setStreamActive(proc.stdout, active);
  setStreamActive(proc.stderr, active);
}

/** 逐行读取器的最小形态：协议帧按 \n 切，尾行不丢 */
async function* lineIterator(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk.toString("utf8");
    let cut = buffer.indexOf("\n");
    while (cut >= 0) {
      yield buffer.slice(0, cut);
      buffer = buffer.slice(cut + 1);
      cut = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0) yield buffer;
}

/** stderr 末行提取：进度条（tqdm）用 \r 原地刷新，按 \r\n 统一切分才拿得到真正的最后一段 */
function lastMeaningfulLine(tail: string): string | undefined {
  return tail
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .pop();
}

/**
 * 会话：一个 shim 进程 = 一次 CLI 调用的引擎侧全部合成。
 * 生命周期：idle 时三个管道流 unref（不拖宿主事件循环，CLI 随时可自然退出）；
 * 在途请求期 ref（合成不被提前回收）；请求收尾归还 unref。进程本体随宿主退出由管道 EOF 收走。
 */
interface ShimSession {
  proc: DaemonProcess;
  lines: AsyncGenerator<string>;
  stderrTail: string;
  nextId: number;
  startPromise: Promise<void> | null;
  /** 请求互斥链：Python 侧串行推理，并发无收益；失败不毒化后续调用 */
  chain: Promise<unknown>;
  /** 会话级死亡信号：exit settle 时 reject 的单例 deferred（per-request 挂钩会在长会话累积监听器） */
  sessionExit: Promise<never>;
}

function spawnSession(spec: GptsovitsLabSpec, host: Host): ShimSession {
  const proc = host.spawnDaemon(spec.pythonPath, [spec.shimPath, "--repo", spec.repoDir]);
  const session: ShimSession = {
    proc,
    lines: lineIterator(proc.stdout),
    stderrTail: "",
    nextId: 1,
    startPromise: null,
    chain: Promise.resolve(),
    sessionExit: new Promise<never>(() => undefined),
  };
  // stderr 从 spawn 即收集（只留尾部 4KB：加载期日志量大，错误现场总在最后），失败时直接读缓冲
  proc.stderr.on("data", (chunk: Buffer) => {
    session.stderrTail = (session.stderrTail + chunk.toString("utf8")).slice(-4096);
  });
  proc.stderr.resume();
  // 死亡信号会话级单例：失败消息带 stderr 现场，无论死亡发生在哪个阶段
  session.sessionExit = new Promise<never>((_, reject) => {
    proc.exit.then(
      () => {
        const last = lastMeaningfulLine(session.stderrTail);
        const suffix = last === undefined ? "" : `（stderr 末行：${last.slice(0, 300)}）`;
        reject(new EngineError(`GPT-SoVITS 进程意外退出${suffix}`));
      },
      () => reject(new EngineError("GPT-SoVITS 进程拉起失败（解释器或 shim 路径不可用）")),
    );
  });
  // idle 态不拖宿主：CLI 在合成完成后事件循环即可排空，子进程由管道 EOF 收走
  setSessionActive(proc, false);
  return session;
}

/** 就绪握手：循环读行直到协议帧（引擎/依赖库的杂散 print 不可预期地混在 ready 之前） */
async function awaitReady(session: ShimSession): Promise<void> {
  setSessionActive(session.proc, true);
  try {
    for (;;) {
      const nextLine = session.lines.next().then((r) => r.value ?? "");
      const deadline = synthDeadline(session, READY_TIMEOUT_MS, "加载");
      const outcome = await Promise.race([nextLine.then((line) => ({ kind: "line" as const, line })), session.sessionExit, deadline]);
      deadline.cancel(); // 收到帧即撤表：残留的 ref 计时器会把 CLI 退出拖满整个加载超时
      const msg = parseLine(outcome.line);
      if (msg === null) continue; // 杂散输出：丢弃继续读
      if (msg.type === "fatal") throw new EngineError(`GPT-SoVITS 加载失败：${msg.message}`);
      if (msg.type === "ready") return;
    }
  } finally {
    setSessionActive(session.proc, false);
  }
}

/** 合成阶段的 deadline：纯计时器（死亡路径走会话级 sessionExit，不在此重复挂钩），返回可取消句柄 */
function synthDeadline(session: ShimSession, ms: number, kind: string): Promise<never> & { cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      session.proc.stdin.end();
      if (session.proc.pid !== null) {
        try {
          process.kill(session.proc.pid, "SIGKILL");
        } catch {
          // 进程已死：kill 失败无意义，结局由 exit 表达
        }
      }
      reject(timeoutError(kind, ms));
    }, ms);
  }) as Promise<never> & { cancel: () => void };
  promise.cancel = () => clearTimeout(timer);
  return promise;
}

function concatSamples(chunks: readonly Float32Array[]): Float32Array {
  if (chunks.length === 1) return chunks[0]!;
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

/**
 * shim 合成函数工厂。返回的函数持有会话，同一引擎实例的多次调用复用同一 Python 进程——
 * 分块流水因此首块付冷启动、后续块全热态，与调研延迟口径（同进程连续请求）对齐。
 */
export function createShimSynth(spec: GptsovitsLabSpec, host: Host): GptsovitsSynth {
  let session: ShimSession | null = null;

  const ensureStarted = async (current: ShimSession): Promise<void> => {
    if (current.startPromise !== null) return current.startPromise;
    current.startPromise = awaitReady(current);
    return current.startPromise;
  };

  const runRequest = async (current: ShimSession, req: GptsovitsSynthRequest & { id: number }): Promise<GptsovitsSynthResult> => {
    await ensureStarted(current);
    setSessionActive(current.proc, true);
    try {
      current.proc.stdin.write(encodeRequest(req));
      // 流式契约：同一 id 可有多块音频，done=true 才是终结帧（单帧 shim 也带 done）
      const chunks: Float32Array[] = [];
      let sampleRate: number | null = null;
      for (;;) {
        const nextLine = current.lines.next().then((r) => ({ kind: "line" as const, line: r.value ?? "" }));
        const deadline = synthDeadline(current, SYNTH_TIMEOUT_MS, "合成");
        const outcome = await Promise.race([nextLine, current.sessionExit, deadline]);
        deadline.cancel();
        const msg = parseLine(outcome.line);
        if (msg === null) continue; // 引擎杂散输出：解析不了就丢，不毒化协议面
        if (msg.type === "fatal") throw new EngineError(`GPT-SoVITS 引擎致命错误：${msg.message}`);
        if (msg.type === "error" && msg.id === req.id) throw new EngineError(`GPT-SoVITS 合成失败：${msg.message}`);
        if (msg.type === "audio" && msg.id === req.id) {
          chunks.push(decodePcm(msg.pcm));
          sampleRate = msg.sampleRate;
          if (msg.done) return { samples: concatSamples(chunks), sampleRate };
        }
      }
    } finally {
      setSessionActive(current.proc, false);
    }
  };

  return (req: GptsovitsSynthRequest): Promise<GptsovitsSynthResult> => {
    if (session === null) session = spawnSession(spec, host);
    const id = session.nextId++;
    const result = session.chain.then(() => runRequest(session!, { ...req, id }), () => runRequest(session!, { ...req, id }));
    session.chain = result.catch(() => undefined);
    return result;
  };
}
