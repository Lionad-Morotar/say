import { EngineError } from "../errors.ts";
import type { Host } from "../host.ts";
import { decodePcm, encodeRequest, parseLine } from "./gptsovits-protocol.ts";
import { awaitShimReady, sessionDeadline, spawnShimSession, setSessionActive, terminatedSessionError, type ShimSession } from "./shim-session.ts";
import { DaemonSession, DaemonUnavailableError, GPTSOVITS_WEIGHT_MARKERS, weightsFingerprint } from "./daemon-session.ts";
import { clearCircuitFailures, type CircuitHandle } from "./daemon-circuit.ts";

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

const ENGINE_LABEL = "GPT-SoVITS";

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

/** 会话装配的引擎侧薄壳：spawn 参数与错误消息 label 是 GPT-SoVITS 仅有的特化点 */
function spawnSession(spec: GptsovitsLabSpec, host: Host): ShimSession {
  const proc = host.spawnDaemon(spec.pythonPath, [spec.shimPath, "--repo", spec.repoDir]);
  return spawnShimSession(ENGINE_LABEL, proc);
}

/**
 * shim 合成函数工厂。返回的函数持有会话，同一引擎实例的多次调用复用同一 Python 进程——
 * 分块流水因此首块付冷启动、后续块全热态，与调研延迟口径（同进程连续请求）对齐。
 */
export function createShimSynth(spec: GptsovitsLabSpec, host: Host): GptsovitsSynth {
  let session: ShimSession | null = null;

  const ensureStarted = async (current: ShimSession): Promise<void> => {
    if (current.startPromise !== null) return current.startPromise;
    current.startPromise = awaitShimReady(current, ENGINE_LABEL, READY_TIMEOUT_MS);
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
        // 流耗尽按会话终止收敛（空窗快转的成因见 shim-session awaitShimReady 注释）
        const deadline = sessionDeadline(current, SYNTH_TIMEOUT_MS, ENGINE_LABEL, "合成");
        const outcome = await Promise.race([current.lines.next(), current.sessionExit, deadline]);
        deadline.cancel();
        if (outcome.done) throw terminatedSessionError(current, ENGINE_LABEL);
        const msg = parseLine(outcome.value ?? "");
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

/** 握手版本键的引擎侧期望：protocol 与 shim PROTOCOL_VERSION 同仓同版（漂移只发生在旧代码拉起的旧 daemon，那正是握手要拒的对象）；
 *  engineVersion 与 shim 构造 TTS_Config 钉死的 version 同源。不符 = 过期 daemon → kill 重拉一次 */
const DAEMON_PROTOCOL_VERSION = "2";
const DAEMON_ENGINE_VERSION = "v2";

/**
 * 队满拒转的 message 前缀：daemon 侧单飞队列上限 4，第 5 路在途请求收到携带该 message 的 error 帧。
 * 这是容量事件不是请求失败——TS 侧按前缀识别后归入基础设施失败（降级 per-call 重放、daemon 不判死、
 * 不进熔断计数），与引擎级 error 帧（重放必复现）分流。message 是跨语言契约，
 * 与 shim 的 QUEUE_FULL_MESSAGE 由源文本对拍测试钉死（shim-daemon.test.ts）。
 */
export const DAEMON_QUEUE_FULL_MESSAGE = "daemon queue full";
/** 闲置收割阈值（分钟）：burst 期间常驻保热、久置回收内存；由 shim daemon 自计时自退 */
const DAEMON_IDLE_MINUTES = 15;

/** daemon 计时旋钮与闲置阈值的覆写面：真机走缺省，测试收窗与缩短收割窗口 */
export interface GptsovitsDaemonTuning {
  idleMinutes?: number;
  readyTimeoutMs?: number;
  warmTimeoutMs?: number;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * daemon-first 合成函数工厂（热启动主路径）：优先经 per-engine 常驻 daemon 合成——
 * unix socket + ready 版本键三元组握手，冷启动整个 burst 只付一次、跨 CLI 调用复用。
 * 分级语义按失败层分流：
 * - 基础设施失败（拒连/拉起死/握手不符/在途断连/超时）→ DaemonUnavailableError →
 *   降级 per-call 重放同一请求（换个进程再跑仍可能成），本实例内 daemon sticky 不再重试；
 * - 引擎级失败（error/fatal 帧）→ EngineError 直报不重放（同一请求 per-call 必复现，
 *   且 per-call 形态报出的原因与 daemon 相同，重放只白付一次冷启动）。
 */
export function createGptsovitsSynth(spec: GptsovitsLabSpec, host: Host, tuning: GptsovitsDaemonTuning = {}): GptsovitsSynth {
  // 熔断句柄跨 CLI 进程经文件会合：now 走 Host 注入（测试推进假时钟免真等）
  const circuit: CircuitHandle = { path: `${spec.labDir}/daemon-failures`, now: () => host.now() };
  const session = new DaemonSession({
    label: ENGINE_LABEL,
    socketPath: `${spec.labDir}/daemon.sock`,
    pidPath: `${spec.labDir}/daemon.pid`,
    circuit,
    idleMinutes: tuning.idleMinutes ?? DAEMON_IDLE_MINUTES,
    spawn: (idleMinutes) => host.spawnDaemon(spec.pythonPath, [spec.shimPath, "--repo", spec.repoDir, "--daemon", "--idle-minutes", String(idleMinutes)]),
    expectedVersionKey: () => ({
      protocol: DAEMON_PROTOCOL_VERSION,
      engineVersion: DAEMON_ENGINE_VERSION,
      weightsFingerprint: weightsFingerprint(spec.labDir, GPTSOVITS_WEIGHT_MARKERS),
    }),
    ...(tuning.readyTimeoutMs !== undefined ? { readyTimeoutMs: tuning.readyTimeoutMs } : {}),
    ...(tuning.warmTimeoutMs !== undefined ? { warmTimeoutMs: tuning.warmTimeoutMs } : {}),
    ...(tuning.requestTimeoutMs !== undefined ? { requestTimeoutMs: tuning.requestTimeoutMs } : {}),
    ...(tuning.pollIntervalMs !== undefined ? { pollIntervalMs: tuning.pollIntervalMs } : {}),
  });

  // per-call 替身会话只在首次降级时装配：daemon 健康时（绝大多数调用）不该为退路付任何进程成本
  let shimSynth: GptsovitsSynth | null = null;
  let nextId = 1;
  let chain: Promise<unknown> = Promise.resolve();

  const runViaDaemon = async (req: GptsovitsSynthRequest, id: number): Promise<GptsovitsSynthResult> => {
    const chunks: Float32Array[] = [];
    let sampleRate: number | null = null;
    for await (const line of session.request(encodeRequest({ ...req, id }))) {
      const msg = parseLine(line);
      if (msg === null) continue; // 杂散行（引擎库噪音进 socket 的既有形态）：丢弃面与 per-call 一致
      if (msg.type === "fatal") throw new EngineError(`${ENGINE_LABEL} 引擎致命错误：${msg.message}`);
      if (msg.type === "error" && msg.id === id) {
        // 队满拒转与引擎级失败分流：前者是容量瞬态（换个进程立即能跑），归基础设施失败降级 per-call；
        // 后者同一请求重放必复现，直报不降级。判据用 shim 的固定 message 前缀，跨语言由对拍测试钉死。
        if (msg.message.startsWith(DAEMON_QUEUE_FULL_MESSAGE)) {
          throw new DaemonUnavailableError(`${ENGINE_LABEL} 常驻队列已满拒转（${msg.message}）`);
        }
        throw new EngineError(`${ENGINE_LABEL} 合成失败：${msg.message}`);
      }
      if (msg.type === "audio" && msg.id === id) {
        chunks.push(decodePcm(msg.pcm));
        sampleRate = msg.sampleRate;
        if (msg.done) {
          // 一次成功的温态合成 = daemon 健康的最强证据：劣化史清零（票 04 熔断回收判据）。
          // 只在 done 终结帧清：半截流/引擎级 error 都不算 daemon 恢复了
          clearCircuitFailures(circuit);
          return { samples: concatSamples(chunks), sampleRate };
        }
      }
    }
    // EOF/超时由 request 传输层抛 DaemonUnavailableError；走到这里是 done 前流自然终结的异常形态
    throw new DaemonUnavailableError(`${ENGINE_LABEL} 常驻形态：响应流在 done 帧前终结`);
  };

  const runOnce = async (req: GptsovitsSynthRequest): Promise<GptsovitsSynthResult> => {
    const id = nextId++;
    try {
      return await runViaDaemon(req, id);
    } catch (error) {
      if (!(error instanceof DaemonUnavailableError)) throw error;
      if (shimSynth === null) shimSynth = createShimSynth(spec, host);
      return shimSynth(req);
    }
  };

  // 单消费者互斥链（daemon 与降级 per-call 同串）：daemon 侧单飞串行、per-call 侧会话链都要求请求逐个进
  return (req: GptsovitsSynthRequest): Promise<GptsovitsSynthResult> => {
    const result = chain.then(() => runOnce(req), () => runOnce(req));
    chain = result.catch(() => undefined);
    return result;
  };
}
