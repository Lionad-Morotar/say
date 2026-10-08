import { BUILTIN_DAEMON_IDLE, type DaemonEngine } from "../config.ts";
import { recordDaemonForm, type DaemonForm } from "../daemon-trace.ts";
import { EngineError } from "../errors.ts";
import type { Host } from "../host.ts";
import { decodePcm, encodeRequest, parseLine } from "./gptsovits-protocol.ts";
import { awaitShimReady, sessionDeadline, spawnShimSession, setSessionActive, terminatedSessionError, type ShimSession } from "./shim-session.ts";
import { DaemonSession, DaemonUnavailableError, FIRERED_WEIGHT_MARKERS, weightsFingerprint } from "./daemon-session.ts";
import { clearCircuitFailures, type CircuitHandle } from "./daemon-circuit.ts";
import { DAEMON_QUEUE_FULL_MESSAGE } from "./gptsovits-binding.ts";

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
        if (outcome.done) throw terminatedSessionError(current, ENGINE_LABEL);
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

/** 握手版本键的引擎侧期望：protocol 与 shim PROTOCOL_VERSION 同仓同版（跨引擎共用一个协议版本轴）；
 *  engineVersion 与 shim ready 帧字面钉死的 "3" 同源。不符 = 过期 daemon → kill 重拉一次 */
const DAEMON_PROTOCOL_VERSION = "2";
const DAEMON_ENGINE_VERSION = "3";
/** 闲置收割缺省档：firered 39GB 档内存占用，用完尽快让出，故取内置表最短档；
 *  单源在 config 内置表，[daemon] 配置层经装配点覆盖；由 shim daemon 自计时自退 */
const DAEMON_IDLE_MINUTES = BUILTIN_DAEMON_IDLE.firered;
/** daemon 加载窗与 per-call READY_TIMEOUT_MS 同口径 240s：20.8GB 权重 + MPS 初始化 +
 *  首跑 kernel 编译余量（调研实测 MPS 冷加载 12s 量级），daemon-session 的全局 120s 默认
 *  会在慢盘误杀加载中的健康进程，再降级 per-call 白付双份冷启动 */
const DAEMON_READY_TIMEOUT_MS = 240_000;
/** 请求 deadline 与 per-call SYNTH_TIMEOUT_MS 同口径 180s：FireRed 长文本引擎内拆句多段串行
 *  是既有注释自证的合成量级上沿（拆句在引擎侧、say 层 chunk 界定不住它），共享层 60s 缺省
 *  会把健康慢合成在途 kill 再从 per-call 整段重放——主路径严于被它替换的退路即「兜底不回退」
 *  的违背形态。indextts/gptsovits 的温态单请求被 say 层分块界定（60s ≈ 数倍余量）维持钉版缺省，
 *  本引擎按 per-engine tuning 面显式放宽（S5 审查 R1 裁决）。hang 判定语义不丢，只顺延到与
 *  per-call 同一预算线。 */
const DAEMON_REQUEST_TIMEOUT_MS = 180_000;

/** daemon 计时旋钮与闲置阈值的覆写面：真机走缺省，测试收窗与缩短收割窗口 */
export interface FireredDaemonTuning {
  idleMinutes?: number;
  /** SAY_DEBUG daemon 段记账键：装配点（引擎工厂）注入；缺席 = 不记账 */
  traceEngine?: DaemonEngine;
  readyTimeoutMs?: number;
  warmTimeoutMs?: number;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * daemon-first 合成函数工厂（热启动 S5 firered 链，gptsovits 钉版同构）：优先经常驻 daemon
 * 合成——unix socket + ready 版本键三元组握手，冷启动整个 burst 只付一次、跨 CLI 调用复用。
 * 分级语义按失败层分流：
 * - 基础设施失败（拒连/拉起死/握手不符/在途断连/超时/队满拒转）→ DaemonUnavailableError →
 *   降级 per-call 重放同一请求（换个进程再跑仍可能成），本实例内 daemon sticky 不再重试；
 * - 引擎级失败（error/fatal 帧）→ EngineError 直报不重放（同一请求 per-call 必复现）。
 * per-call 退路复用 createShimSynth：daemon 上线前形态逐字保留，兜底不回退。
 * daemon spawn 与 per-call 同带 FIRERED_DEVICE env：设备选择链两形态同一条，
 * device 本身不入握手版本键（三元组既有裁决——device 漂移不产错音只产快慢）。
 */
export function createFireredSynth(spec: FireredLabSpec, host: Host, tuning: FireredDaemonTuning = {}): FireredSynth {
  // 熔断句柄跨 CLI 进程经文件会合：now 走 Host 注入（测试推进假时钟免真等）
  const circuit: CircuitHandle = { path: `${spec.labDir}/daemon-failures`, now: () => host.now() };
  // SAY_DEBUG daemon 段记账：traceEngine 缺席 = 不记账（测试直装配不污染进程单例）
  const record = (form: DaemonForm, coldMs: number | null = null): void => {
    if (tuning.traceEngine !== undefined) recordDaemonForm(tuning.traceEngine, form, coldMs);
  };
  const session = new DaemonSession({
    label: ENGINE_LABEL,
    socketPath: `${spec.labDir}/daemon.sock`,
    pidPath: `${spec.labDir}/daemon.pid`,
    circuit,
    idleMinutes: tuning.idleMinutes ?? DAEMON_IDLE_MINUTES,
    ...(tuning.traceEngine !== undefined
      ? {
          observe: (event: { kind: "established"; form: "warm" | "cold"; coldMs: number } | { kind: "cooldown" }) =>
            event.kind === "established" ? record(event.form, event.coldMs) : record("cooldown"),
        }
      : {}),
    spawn: (idleMinutes) =>
      host.spawnDaemon(spec.pythonPath, [spec.shimPath, "--repo", spec.repoDir, "--models", spec.modelsDir, "--daemon", "--idle-minutes", String(idleMinutes)], {
        env: { FIRERED_DEVICE: fireredDevice(host.env) },
      }),
    expectedVersionKey: () => ({
      protocol: DAEMON_PROTOCOL_VERSION,
      engineVersion: DAEMON_ENGINE_VERSION,
      weightsFingerprint: weightsFingerprint(spec.labDir, FIRERED_WEIGHT_MARKERS),
    }),
    readyTimeoutMs: tuning.readyTimeoutMs ?? DAEMON_READY_TIMEOUT_MS,
    requestTimeoutMs: tuning.requestTimeoutMs ?? DAEMON_REQUEST_TIMEOUT_MS,
    ...(tuning.warmTimeoutMs !== undefined ? { warmTimeoutMs: tuning.warmTimeoutMs } : {}),
    ...(tuning.pollIntervalMs !== undefined ? { pollIntervalMs: tuning.pollIntervalMs } : {}),
  });

  // per-call 替身会话只在首次降级时装配：daemon 健康时（绝大多数调用）不该为退路付任何进程成本
  let shimSynth: FireredSynth | null = null;
  let nextId = 1;
  let chain: Promise<unknown> = Promise.resolve();

  const runViaDaemon = async (req: FireredSynthRequest, id: number): Promise<FireredSynthResult> => {
    const chunks: Float32Array[] = [];
    let sampleRate: number | null = null;
    // 请求帧与 per-call runRequest 逐字同构（帧不动、只换传输）：FireRed 的克隆质量依赖
    // prompt_text 与参考严格对应，转写字段原样下传
    for await (const line of session.request(
      encodeRequest({
        id,
        text: req.text,
        refAudioPath: req.refAudioPath,
        promptText: req.promptText,
        promptLang: "auto",
        textLang: req.textLang,
        speedFactor: 1.0,
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

  const runOnce = async (req: FireredSynthRequest): Promise<FireredSynthResult> => {
    const id = nextId++;
    try {
      return await runViaDaemon(req, id);
    } catch (error) {
      if (!(error instanceof DaemonUnavailableError)) throw error;
      record("per-call");
      if (shimSynth === null) shimSynth = createShimSynth(spec, host);
      return shimSynth(req);
    }
  };

  // 单消费者互斥链（daemon 与降级 per-call 同串）：daemon 侧单飞串行、per-call 侧会话链都要求请求逐个进
  return (req: FireredSynthRequest): Promise<FireredSynthResult> => {
    const result = chain.then(() => runOnce(req), () => runOnce(req));
    chain = result.catch(() => undefined);
    return result;
  };
}
