import { BUILTIN_DAEMON_IDLE } from "../config.ts";
import { EngineError } from "../errors.ts";
import type { Host } from "../host.ts";
import { decodePcm, encodeRequest, parseLine } from "./gptsovits-protocol.ts";
import { awaitShimReady, sessionDeadline, spawnShimSession, setSessionActive, terminatedSessionError, type ShimSession } from "./shim-session.ts";
import { DaemonSession, DaemonUnavailableError, INDEXTTS_WEIGHT_MARKERS, weightsFingerprint } from "./daemon-session.ts";
import { clearCircuitFailures, type CircuitHandle } from "./daemon-circuit.ts";
import { DAEMON_QUEUE_FULL_MESSAGE } from "./gptsovits-binding.ts";

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

/** 握手版本键的引擎侧期望：protocol 与 shim PROTOCOL_VERSION 同仓同版（跨引擎共用一个协议版本轴）；
 *  engineVersion 与 shim ready 帧字面钉死的 "2.5" 同源。不符 = 过期 daemon → kill 重拉一次 */
const DAEMON_PROTOCOL_VERSION = "2";
const DAEMON_ENGINE_VERSION = "2.5";
/** 闲置收割缺省档：zh 默认链高频 + 冷启动最贵，burst 保温收益最大，故取内置表最长档；
 *  单源在 config 内置表，[daemon] 配置层经装配点覆盖；由 shim daemon 自计时自退 */
const DAEMON_IDLE_MINUTES = BUILTIN_DAEMON_IDLE.indextts;
/** daemon 加载窗与 per-call READY_TIMEOUT_MS 同口径 240s：5GB 权重 + MPS 初始化 + auto 层首跑自拉
 *  余量（实测首跑 76.7s），daemon-session 的全局 120s 默认是 gptsovits 12s 加载的十倍余量、
 *  不覆盖 indextts 首跑形态，误杀加载中的健康进程再降级 per-call 白付双份冷启动 */
const DAEMON_READY_TIMEOUT_MS = 240_000;

/** daemon 计时旋钮与闲置阈值的覆写面：真机走缺省，测试收窗与缩短收割窗口 */
export interface IndexttsDaemonTuning {
  idleMinutes?: number;
  readyTimeoutMs?: number;
  warmTimeoutMs?: number;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * daemon-first 合成函数工厂（热启动 S3 indextts 链主路径，gptsovits 钉版同构）：优先经常驻 daemon
 * 合成——unix socket + ready 版本键三元组握手，冷启动整个 burst 只付一次、跨 CLI 调用复用。
 * 分级语义按失败层分流：
 * - 基础设施失败（拒连/拉起死/握手不符/在途断连/超时/队满拒转）→ DaemonUnavailableError →
 *   降级 per-call 重放同一请求（换个进程再跑仍可能成），本实例内 daemon sticky 不再重试；
 * - 引擎级失败（error/fatal 帧）→ EngineError 直报不重放（同一请求 per-call 必复现）。
 * per-call 退路复用 createShimSynth：daemon 上线前形态逐字保留，兜底不回退。
 */
export function createIndexttsSynth(spec: IndexttsLabSpec, host: Host, tuning: IndexttsDaemonTuning = {}): IndexttsSynth {
  // 熔断句柄跨 CLI 进程经文件会合：now 走 Host 注入（测试推进假时钟免真等）
  const circuit: CircuitHandle = { path: `${spec.labDir}/daemon-failures`, now: () => host.now() };
  const session = new DaemonSession({
    label: ENGINE_LABEL,
    socketPath: `${spec.labDir}/daemon.sock`,
    pidPath: `${spec.labDir}/daemon.pid`,
    circuit,
    idleMinutes: tuning.idleMinutes ?? DAEMON_IDLE_MINUTES,
    spawn: (idleMinutes) => host.spawnDaemon(spec.pythonPath, [spec.shimPath, "--repo", spec.repoDir, "--models", spec.modelsDir, "--daemon", "--idle-minutes", String(idleMinutes)]),
    expectedVersionKey: () => ({
      protocol: DAEMON_PROTOCOL_VERSION,
      engineVersion: DAEMON_ENGINE_VERSION,
      weightsFingerprint: weightsFingerprint(spec.labDir, INDEXTTS_WEIGHT_MARKERS),
    }),
    readyTimeoutMs: tuning.readyTimeoutMs ?? DAEMON_READY_TIMEOUT_MS,
    ...(tuning.warmTimeoutMs !== undefined ? { warmTimeoutMs: tuning.warmTimeoutMs } : {}),
    ...(tuning.requestTimeoutMs !== undefined ? { requestTimeoutMs: tuning.requestTimeoutMs } : {}),
    ...(tuning.pollIntervalMs !== undefined ? { pollIntervalMs: tuning.pollIntervalMs } : {}),
  });

  // per-call 替身会话只在首次降级时装配：daemon 健康时（绝大多数调用）不该为退路付任何进程成本
  let shimSynth: IndexttsSynth | null = null;
  let nextId = 1;
  let chain: Promise<unknown> = Promise.resolve();

  const runViaDaemon = async (req: IndexttsSynthRequest, id: number): Promise<IndexttsSynthResult> => {
    const chunks: Float32Array[] = [];
    let sampleRate: number | null = null;
    // 请求帧与 per-call runRequest 逐字同构（帧不动、只换传输）：prompt_text/prompt_lang 是
    // gptsovits 协议必填字段，IndexTTS shim 忽略它们、零样本参考走 ref_audio_path
    for await (const line of session.request(
      encodeRequest({
        id,
        text: req.text,
        refAudioPath: req.refAudioPath,
        promptText: "",
        promptLang: "auto",
        textLang: req.textLang,
        speedFactor: 1.0,
        ...(req.durationFactor !== undefined ? { durationFactor: req.durationFactor } : {}),
        ...(req.emoAlpha !== undefined ? { emoAlpha: req.emoAlpha } : {}),
      }),
    )) {
      const msg = parseLine(line);
      if (msg === null) continue; // 杂散行（引擎库噪音进 socket 的既有形态）：丢弃面与 per-call 一致
      if (msg.type === "fatal") throw new EngineError(`${ENGINE_LABEL} 引擎致命错误：${msg.message}`);
      if (msg.type === "error" && msg.id === id) {
        // 队满拒转是容量瞬态（换个进程立即能跑），归基础设施失败降级 per-call；引擎级失败重放必复现，直报
        if (msg.message.startsWith(DAEMON_QUEUE_FULL_MESSAGE)) {
          throw new DaemonUnavailableError(`${ENGINE_LABEL} 常驻队列已满拒转（${msg.message}）`);
        }
        throw new EngineError(`${ENGINE_LABEL} 合成失败：${msg.message}`);
      }
      if (msg.type === "audio" && msg.id === id) {
        chunks.push(decodePcm(msg.pcm));
        sampleRate = msg.sampleRate;
        if (msg.done) {
          // 一次成功的温态合成 = daemon 健康的最强证据：劣化史清零（票 04 熔断回收判据）
          clearCircuitFailures(circuit);
          return { samples: concatSamples(chunks), sampleRate };
        }
      }
    }
    // EOF/超时由 request 传输层抛 DaemonUnavailableError；走到这里是 done 前流自然终结的异常形态
    throw new DaemonUnavailableError(`${ENGINE_LABEL} 常驻形态：响应流在 done 帧前终结`);
  };

  const runOnce = async (req: IndexttsSynthRequest): Promise<IndexttsSynthResult> => {
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
  return (req: IndexttsSynthRequest): Promise<IndexttsSynthResult> => {
    const result = chain.then(() => runOnce(req), () => runOnce(req));
    chain = result.catch(() => undefined);
    return result;
  };
}
