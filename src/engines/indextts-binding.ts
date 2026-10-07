import { EngineError } from "../errors.ts";
import type { Host } from "../host.ts";
import { decodePcm, encodeRequest, parseLine } from "./gptsovits-protocol.ts";
import { awaitShimReady, sessionDeadline, spawnShimSession, setSessionActive, terminatedSessionError, type ShimSession } from "./shim-session.ts";

/** say-lab 引擎安装面（路径判据与 scripts/lib/engine-status.mjs 同构） */
export interface IndexttsLabSpec {
  /** say-lab 引擎目录（~/.local/share/say-lab/indextts） */
  labDir: string;
  /** index-tts 仓库根（labDir/index-tts），shim 的 --repo 参数与 sys.path 定位点 */
  repoDir: string;
  /** checkpoints 目录（labDir/checkpoints），shim 的 --models 参数 */
  modelsDir: string;
  /** venv 解释器（labDir/index-tts/.venv/bin/python，uv sync 自建） */
  pythonPath: string;
  /** shim 脚本绝对路径（say 仓 scripts/shims/indextts-shim.py） */
  shimPath: string;
}

export interface IndexttsSynthRequest {
  text: string;
  /** 说话人参考音频（零样本克隆引擎必带：角色目录 ref 或引擎仓自带示例） */
  refAudioPath: string;
  /** 合成文本语言（协议 text_lang 即引擎 lang，Node 侧自判 zh/en 下传） */
  textLang: string;
  /** 时长倍率（duration_factor 直传）；缺席 = 引擎默认 1.0 */
  durationFactor?: number;
  /** 情感强度预留；一期不发送 */
  emoAlpha?: number;
}

export interface IndexttsSynthResult {
  samples: Float32Array;
  sampleRate: number;
}

/** 合成函数类型：适配器只认这个面，测试注入 fake 而不触真实 shim 进程 */
export type IndexttsSynth = (req: IndexttsSynthRequest) => Promise<IndexttsSynthResult>;

/** 冷加载是 5GB 权重 + MPS 初始化 + auto 层首跑自拉余量；240s 覆盖慢盘首跑 */
const READY_TIMEOUT_MS = 240_000;
/** 热合成 4-6s、emo 参考链路翻倍、坏例重试延迟翻倍的量级；180s 与 gptsovits 同口径 */
const SYNTH_TIMEOUT_MS = 180_000;

const ENGINE_LABEL = "IndexTTS";

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

/** 会话装配的引擎侧薄壳：spawn 参数与错误消息 label 是 IndexTTS 仅有的特化点 */
function spawnSession(spec: IndexttsLabSpec, host: Host): ShimSession {
  const proc = host.spawnDaemon(spec.pythonPath, [spec.shimPath, "--repo", spec.repoDir, "--models", spec.modelsDir]);
  return spawnShimSession(ENGINE_LABEL, proc);
}

/**
 * shim 合成函数工厂。整句消费形态与 gptsovits-binding 同构（收 done 帧整句返回、
 * 请求互斥链、per-call 常驻），IndexTTS 特有的 duration_factor/emo_alpha 经协议可选字段直传。
 */
export function createShimSynth(spec: IndexttsLabSpec, host: Host): IndexttsSynth {
  let session: ShimSession | null = null;

  const ensureStarted = async (current: ShimSession): Promise<void> => {
    if (current.startPromise !== null) return current.startPromise;
    current.startPromise = awaitShimReady(current, ENGINE_LABEL, READY_TIMEOUT_MS);
    return current.startPromise;
  };

  const runRequest = async (current: ShimSession, req: IndexttsSynthRequest & { id: number }): Promise<IndexttsSynthResult> => {
    await ensureStarted(current);
    setSessionActive(current.proc, true);
    try {
      current.proc.stdin.write(
        encodeRequest({
          id: req.id,
          text: req.text,
          refAudioPath: req.refAudioPath,
          promptText: "",
          promptLang: "auto",
          textLang: req.textLang,
          speedFactor: 1.0,
          ...(req.durationFactor !== undefined ? { durationFactor: req.durationFactor } : {}),
          ...(req.emoAlpha !== undefined ? { emoAlpha: req.emoAlpha } : {}),
        }),
      );
      // 流式契约：IndexTTS shim 单帧交付（整句形态），done=true 即终结帧
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
        if (msg.type === "fatal") throw new EngineError(`IndexTTS 引擎致命错误：${msg.message}`);
        if (msg.type === "error" && msg.id === req.id) throw new EngineError(`IndexTTS 合成失败：${msg.message}`);
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

  return (req: IndexttsSynthRequest): Promise<IndexttsSynthResult> => {
    if (session === null) session = spawnSession(spec, host);
    const id = session.nextId++;
    const result = session.chain.then(() => runRequest(session!, { ...req, id }), () => runRequest(session!, { ...req, id }));
    session.chain = result.catch(() => undefined);
    return result;
  };
}
