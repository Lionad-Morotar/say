import { EngineError } from "../errors.ts";
import type { Host } from "../host.ts";
import { decodePcm, encodeRequest, parseLine } from "./gptsovits-protocol.ts";
import { awaitShimReady, lastMeaningfulLine, sessionDeadline, spawnShimSession, setSessionActive, type ShimSession } from "./shim-session.ts";

/** 流已终止的会话错误：错误现场从 stderr 尾部取（与 shim-session 的 terminatedError 同构，label 各归引擎） */
function terminatedSessionError(current: ShimSession): EngineError {
  const last = lastMeaningfulLine(current.stderrTail);
  const suffix = last === undefined ? "" : `（stderr 末行：${last.slice(0, 300)}）`;
  return new EngineError(`FireRed 进程输出已终止${suffix}`);
}

/** say-lab 引擎安装面（路径判据与 scripts/lib/engine-status.mjs 同构） */
export interface FireredLabSpec {
  /** say-lab 引擎目录（~/.local/share/say-lab/firered） */
  labDir: string;
  /** FireRedTTS3 仓库根（labDir/FireRedTTS3），shim 的 --repo 参数与 sys.path 定位点 */
  repoDir: string;
  /** pretrained_model_dir（labDir/models/FireRedTTS3），shim 的 --models 参数 */
  modelsDir: string;
  /** venv 解释器（labDir/venv/bin/python） */
  pythonPath: string;
  /** shim 脚本绝对路径（say 仓 scripts/shims/firered-shim.py） */
  shimPath: string;
}

export interface FireredSynthRequest {
  text: string;
  /** 参考音频路径（零样本克隆引擎必带：角色目录 ref 或 default 官方参考） */
  refAudioPath: string;
  /** 参考音频转写（FireRed 克隆必带：转写与音频失配直接伤克隆质量） */
  promptText: string;
  /** 合成文本语言（协议 text_lang，shim 内映射 FireRed 白名单 tag） */
  textLang: string;
}

export interface FireredSynthResult {
  samples: Float32Array;
  sampleRate: number;
}

/** 合成函数类型：适配器只认这个面，测试注入 fake 而不触真实 shim 进程 */
export type FireredSynth = (req: FireredSynthRequest) => Promise<FireredSynthResult>;

/**
 * FireRed 的 MPS 设备面：上游硬编码 cuda 已被安装面 patch 参数化为 FIRERED_DEVICE env。
 * darwin 默认 mps（调研实证快 CPU 5.8-6.3 倍），其他平台回落 cpu；用户显式设置的值永远胜出。
 */
export function fireredDevice(env: { readonly [k: string]: string | undefined }, platform: NodeJS.Platform = process.platform): string {
  const explicit = env.FIRERED_DEVICE;
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return platform === "darwin" ? "mps" : "cpu";
}

/** 冷加载是 20.8GB 权重 + MPS 初始化余量；240s 覆盖慢盘首跑（调研实测 MPS 冷加载 12s 量级） */
const READY_TIMEOUT_MS = 240_000;
/** 热合成 4.5-5.5s、长文本自动拆句多段串行的量级；180s 与 gptsovits/indextts 同口径 */
const SYNTH_TIMEOUT_MS = 180_000;

const ENGINE_LABEL = "FireRed";

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

/** 会话装配的引擎侧薄壳：spawn 参数、FIRERED_DEVICE 注入与错误消息 label 是 FireRed 仅有的特化点 */
function spawnSession(spec: FireredLabSpec, host: Host): ShimSession {
  const proc = host.spawnDaemon(
    spec.pythonPath,
    [spec.shimPath, "--repo", spec.repoDir, "--models", spec.modelsDir],
    { env: { FIRERED_DEVICE: fireredDevice(host.env) } },
  );
  return spawnShimSession(ENGINE_LABEL, proc);
}

/**
 * shim 合成函数工厂。整句消费形态与 indextts-binding 同构（收 done 帧整句返回、
 * 请求互斥链、per-call 常驻），FireRed 特有的 promptText 经协议可选字段直传；
 * 语速不透出（Base.generate 无语速参数，指令控制面属 Instruct 上游 bug 规避范围外）。
 */
export function createShimSynth(spec: FireredLabSpec, host: Host): FireredSynth {
  let session: ShimSession | null = null;

  const ensureStarted = async (current: ShimSession): Promise<void> => {
    if (current.startPromise !== null) return current.startPromise;
    current.startPromise = awaitShimReady(current, ENGINE_LABEL, READY_TIMEOUT_MS);
    return current.startPromise;
  };

  const runRequest = async (current: ShimSession, req: FireredSynthRequest & { id: number }): Promise<FireredSynthResult> => {
    await ensureStarted(current);
    setSessionActive(current.proc, true);
    try {
      current.proc.stdin.write(
        encodeRequest({
          id: req.id,
          text: req.text,
          refAudioPath: req.refAudioPath,
          promptText: req.promptText,
          promptLang: "auto",
          textLang: req.textLang,
          speedFactor: 1.0,
        }),
      );
      // 流式契约：FireRed shim 单帧交付（整句形态），done=true 即终结帧
      const chunks: Float32Array[] = [];
      let sampleRate: number | null = null;
      for (;;) {
        // 流耗尽按会话终止收敛（空窗快转的成因见 shim-session awaitShimReady 注释）
        const deadline = sessionDeadline(current, SYNTH_TIMEOUT_MS, ENGINE_LABEL, "合成");
        const outcome = await Promise.race([current.lines.next(), current.sessionExit, deadline]);
        deadline.cancel();
        if (outcome.done) throw terminatedSessionError(current);
        const msg = parseLine(outcome.value ?? "");
        if (msg === null) continue; // 引擎杂散输出：解析不了就丢，不毒化协议面
        if (msg.type === "fatal") throw new EngineError(`FireRed 引擎致命错误：${msg.message}`);
        if (msg.type === "error" && msg.id === req.id) throw new EngineError(`FireRed 合成失败：${msg.message}`);
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

  return (req: FireredSynthRequest): Promise<FireredSynthResult> => {
    if (session === null) session = spawnSession(spec, host);
    const id = session.nextId++;
    const result = session.chain.then(() => runRequest(session!, { ...req, id }), () => runRequest(session!, { ...req, id }));
    session.chain = result.catch(() => undefined);
    return result;
  };
}
