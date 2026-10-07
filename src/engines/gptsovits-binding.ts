import { EngineError } from "../errors.ts";
import type { Host } from "../host.ts";
import { decodePcm, encodeRequest, parseLine } from "./gptsovits-protocol.ts";
import { awaitShimReady, sessionDeadline, spawnShimSession, setSessionActive, terminatedSessionError, type ShimSession } from "./shim-session.ts";

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
