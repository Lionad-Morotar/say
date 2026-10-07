import { EngineError } from "../errors.ts";
import type { DaemonProcess } from "../host.ts";

/**
 * 协议 shim 会话的共享骨架（引擎层 v2 协议钉版的执行面工具，S4 提取）：
 * spawn/握手/互斥/超时/死亡信号这些会话机制与具体引擎无关——差异只在
 * shim 的启动参数、请求编码与响应消费形态，各自留在引擎的 binding 里。
 * S3（gptsovits）钉版的行为语义在此逐字节保持，S4（voxcpm）起共用。
 */

/** 会话：一个 shim 进程 = 一次 CLI 调用的引擎侧全部合成 */
export interface ShimSession {
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

export function setSessionActive(proc: DaemonProcess, active: boolean): void {
  setStreamActive(proc.stdin, active);
  setStreamActive(proc.stdout, active);
  setStreamActive(proc.stderr, active);
}

/** 逐行读取器的最小形态：协议帧按 \n 切，尾行不丢 */
export async function* lineIterator(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
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
export function lastMeaningfulLine(tail: string): string | undefined {
  return tail
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .pop();
}

/**
 * 会话装配：生命周期与死亡信号在这里接好。
 * 生命周期：idle 时三个管道流 unref（不拖宿主事件循环，CLI 随时可自然退出）；
 * 在途请求期 ref（合成不被提前回收）；请求收尾归还 unref。进程本体随宿主退出由管道 EOF 收走。
 * label 用于错误消息的引擎名前缀（与 S3 gptsovits 逐字节一致的形态）。
 */
export function spawnShimSession(label: string, proc: DaemonProcess): ShimSession {
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
        reject(new EngineError(`${label} 进程意外退出${suffix}`));
      },
      () => reject(new EngineError(`${label} 进程拉起失败（解释器或 shim 路径不可用）`)),
    );
  });
  // idle 态不拖宿主：CLI 在合成完成后事件循环即可排空，子进程由管道 EOF 收走
  setSessionActive(proc, false);
  return session;
}

/** 会话阶段的 deadline：纯计时器（死亡路径走会话级 sessionExit，不在此重复挂钩），到点杀进程并 reject，返回可取消句柄 */
export function sessionDeadline(
  session: ShimSession,
  ms: number,
  label: string,
  kind: string,
): Promise<never> & { cancel: () => void } {
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
      reject(new EngineError(`${label} ${kind}超时（>${Math.round(ms / 1000)}s）：进程无响应，已终止`));
    }, ms);
  }) as Promise<never> & { cancel: () => void };
  promise.cancel = () => clearTimeout(timer);
  return promise;
}

/**
 * 就绪握手：循环读行直到协议帧（引擎/依赖库的杂散 print 不可预期地混在 ready 之前）。
 * fatal 按加载失败抛出（进程将退出），杂散行丢弃继续读。
 * 流耗尽（done）按会话终止收敛：stdout EOF 与 exit 事件之间有空窗，若在此空窗里
 * 继续竞速，耗尽后立即 resolve 的 next() 会凭数组序永远赢过 sessionExit——
 * 空行快转 + 每圈一个 deadline 定时器，毫秒级烧穿堆（真机 OOM 实证）。
 */
export async function awaitShimReady(session: ShimSession, label: string, timeoutMs: number): Promise<void> {
  setSessionActive(session.proc, true);
  try {
    for (;;) {
      const deadline = sessionDeadline(session, timeoutMs, label, "加载");
      const outcome = await Promise.race([session.lines.next(), session.sessionExit, deadline]);
      deadline.cancel(); // 收到帧即撤表：残留的 ref 计时器会把 CLI 退出拖满整个加载超时
      if (outcome.done) throw terminatedError(session, label);
      const parsed = parseProtocolLine(outcome.value ?? "");
      if (parsed === null) continue; // 杂散输出：丢弃继续读
      if (parsed.type === "fatal") throw new EngineError(`${label} 加载失败：${parsed.message}`);
      if (parsed.type === "ready") return;
    }
  } finally {
    setSessionActive(session.proc, false);
  }
}

/** 流已终止的会话错误：错误现场从 stderr 尾部取（死亡原因总在最后几行） */
function terminatedError(session: ShimSession, label: string): EngineError {
  const last = lastMeaningfulLine(session.stderrTail);
  const suffix = last === undefined ? "" : `（stderr 末行：${last.slice(0, 300)}）`;
  return new EngineError(`${label} 进程输出已终止${suffix}`);
}

/** 行 → ready/fatal 消息的最小判定（完整编解码归各引擎的 protocol 模块，握手两帧型全引擎一致） */
function parseProtocolLine(line: string): { type: "ready" } | { type: "fatal"; message: string } | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const raw = JSON.parse(trimmed) as Record<string, unknown>;
    if (raw.type === "ready") return { type: "ready" };
    if (raw.type === "fatal" && typeof raw.message === "string") return { type: "fatal", message: raw.message };
    return null;
  } catch {
    return null;
  }
}
