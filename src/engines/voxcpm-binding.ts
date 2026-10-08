import { BUILTIN_DAEMON_IDLE } from "../config.ts";
import { EngineError, messageOf } from "../errors.ts";
import type { Host } from "../host.ts";
import { decodePcm, encodeRequest, parseLine } from "./gptsovits-protocol.ts";
import { awaitShimReady, sessionDeadline, spawnShimSession, setSessionActive, terminatedSessionError, type ShimSession } from "./shim-session.ts";
import { DaemonSession, DaemonUnavailableError, VOXCPM_WEIGHT_MARKERS, weightsFingerprint } from "./daemon-session.ts";
import { clearCircuitFailures, type CircuitHandle } from "./daemon-circuit.ts";
import { DAEMON_QUEUE_FULL_MESSAGE } from "./gptsovits-binding.ts";

/**
 * VoxCPM2 流式合成会话（引擎层 v2 协议复用，S4）：与 gptsovits-binding 同一钉版协议，
 * 消费形态是本文件仅有的本质差异——gptsovits 收齐 done 帧整句返回，
 * 这里把每个 audio 帧即时转交消费方（generate_streaming 的首包 0.2-0.5s 因此不被整句合成吃掉）。
 */

/** say-lab 引擎安装面（路径判据与 scripts/lib/engine-status.mjs 同构） */
export interface VoxcpmLabSpec {
  /** say-lab 引擎目录（~/.local/share/say-lab/voxcpm） */
  labDir: string;
  /** 模型资产目录（labDir/models，shim 的 --models 参数 = from_pretrained 本地目录） */
  modelsDir: string;
  /** venv 解释器（labDir/venv/bin/python） */
  pythonPath: string;
  /** shim 脚本绝对路径（say 仓 scripts/shims/voxcpm-shim.py） */
  shimPath: string;
}

export interface VoxcpmSynthRequest {
  text: string;
  /** 零样本克隆参考（角色嗓）；null = 无参考的 voice creation 模式 */
  refAudioPath: string | null;
  /** 参考转写（与 refAudioPath 成对，引擎强制成对校验） */
  promptText: string | null;
  /** voice creation / 可控克隆的自然语言指令；null = 无指令 */
  control: string | null;
}

/** 单个流式音频块：done=true 的块是终结块（协议尾帧语义） */
export interface VoxcpmChunk {
  samples: Float32Array;
  sampleRate: number;
  done: boolean;
}

/** 流式合成函数：消费方 for-await 到 done 块收尾，中途抛 EngineError 即失败进回退链 */
export type VoxcpmStreamSynth = (req: VoxcpmSynthRequest) => AsyncGenerator<VoxcpmChunk>;

/** 模型加载 + optimize 构造期 warm-up（一次完整合成）~20s 量级；180s 给首跑 torch.compile 与慢盘余量 */
const READY_TIMEOUT_MS = 180_000;
/** 帧间活动性判死：流式总时长不可预知（42 块/句随句长变），每收一帧重置；180s 静止保守覆盖坏例重试的延迟翻倍 */
const IDLE_TIMEOUT_MS = 180_000;

const ENGINE_LABEL = "VoxCPM";

/**
 * 互斥门：流式请求的「完成」是消费方驱动 generator 到终结，不能像整句形态那样
 * 用 promise settle 直接归还——turn 信号由 generator 的 finally resolve，提前 break 也算归还。
 * acquire 必须同步成对调用（JS 单线程保证两次 acquire 看到正确的 prev）。
 */
function acquire(current: ShimSession): { waitForTurn: Promise<void>; done: () => void } {
  let done: () => void = () => undefined;
  const turn = new Promise<void>((resolve) => {
    done = resolve;
  });
  const prev = current.chain;
  current.chain = turn;
  return { waitForTurn: prev.then(() => undefined, () => undefined), done };
}

/** 会话装配的引擎侧薄壳：spawn 参数与 label 是 VoxCPM 仅有的特化点 */
function spawnSession(spec: VoxcpmLabSpec, host: Host): ShimSession {
  const proc = host.spawnDaemon(spec.pythonPath, [spec.shimPath, "--models", spec.modelsDir]);
  return spawnShimSession(ENGINE_LABEL, proc);
}

/**
 * 流式合成函数工厂。会话生命周期与 gptsovits 同构（per-call 常驻、idle unref、互斥链），
 * 消费形态差异见文件头；创建即消费是消费方契约（未消费的 generator 会让互斥门悬空）。
 */
export function createShimStreamSynth(spec: VoxcpmLabSpec, host: Host): VoxcpmStreamSynth {
  let session: ShimSession | null = null;

  const ensureStarted = async (current: ShimSession): Promise<void> => {
    if (current.startPromise !== null) return current.startPromise;
    current.startPromise = awaitShimReady(current, ENGINE_LABEL, READY_TIMEOUT_MS);
    return current.startPromise;
  };

  const runStream = async function* (current: ShimSession, req: VoxcpmSynthRequest & { id: number }): AsyncGenerator<VoxcpmChunk> {
    await ensureStarted(current);
    setSessionActive(current.proc, true);
    try {
      current.proc.stdin.write(
        encodeRequest({
          id: req.id,
          text: req.text,
          // 协议通用字段对 VoxCPM 无消费方（引擎多语原生无 lang 参数），按 gptsovits 字段名占位传缺省值
          refAudioPath: req.refAudioPath ?? "",
          promptText: req.promptText ?? "",
          promptLang: "auto",
          textLang: "auto",
          speedFactor: 1.0,
          ...(req.control !== null ? { control: req.control } : {}),
        }),
      );
      for (;;) {
        // 流耗尽按会话终止收敛（terminatedError 的空窗快转成因见 shim-session awaitShimReady 注释）
        const deadline = sessionDeadline(current, IDLE_TIMEOUT_MS, ENGINE_LABEL, "帧间");
        const outcome = await Promise.race([current.lines.next(), current.sessionExit, deadline]);
        deadline.cancel();
        if (outcome.done) throw terminatedSessionError(current, ENGINE_LABEL);
        const msg = parseLine(outcome.value ?? "");
        if (msg === null) continue; // 引擎杂散输出：解析不了就丢，不毒化协议面
        if (msg.type === "fatal") throw new EngineError(`VoxCPM 引擎致命错误：${msg.message}`);
        if (msg.type === "error" && msg.id === req.id) throw new EngineError(`VoxCPM 合成失败：${msg.message}`);
        if (msg.type === "audio" && msg.id === req.id) {
          yield { samples: decodePcm(msg.pcm), sampleRate: msg.sampleRate, done: msg.done };
          if (msg.done) return;
        }
      }
    } finally {
      setSessionActive(current.proc, false);
    }
  };

  return (req: VoxcpmSynthRequest): AsyncGenerator<VoxcpmChunk> => {
    if (session === null) session = spawnSession(spec, host);
    const current = session;
    const id = current.nextId++;
    const { waitForTurn, done } = acquire(current);
    return (async function* () {
      try {
        await waitForTurn;
        yield* runStream(current, { ...req, id });
      } finally {
        done();
      }
    })();
  };
}

/** 握手版本键的引擎侧期望：protocol 与 shim PROTOCOL_VERSION 同仓同版（跨引擎共用一个协议版本轴）；
 *  engineVersion 钉 "VoxCPM2Model"——shim ready 帧的 version 走运行时类名（architecture=voxcpm2 的
 *  分派产物），类名不符 = 模型代际漂移，握手拒载自动重拉降级；config.json 在权重指纹清单内，
 *  代际变更必同时击穿指纹，双路自兜（决策台账 D2 取证） */
const DAEMON_PROTOCOL_VERSION = "2";
const DAEMON_ENGINE_VERSION = "VoxCPM2Model";
/** 闲置收割缺省档：voxcpm 4.6GB 档取默认档（burst 间隔容忍度高于 firered 的 5 分钟档），
 *  单源在 config 内置表，[daemon] 配置层经装配点覆盖 */
const DAEMON_IDLE_MINUTES = BUILTIN_DAEMON_IDLE.voxcpm;
/** daemon 加载窗与 per-call READY_TIMEOUT_MS 同口径 180s：from_pretrained + optimize 构造期
 *  warm-up（一次完整合成）的量级，慢盘首跑 torch.compile 余量含在内 */
const DAEMON_READY_TIMEOUT_MS = 180_000;
/** 请求 deadline 与 per-call IDLE_TIMEOUT_MS 同预算线 180s（R1 原则「主路径不严于退路」的
 *  流式化落点）：daemon 层窗口是整请求绝对制，per-call 是帧间活动制——流式单请求生成总时长
 *  随句长变（42 块/句量级），叠加 daemon 侧最多 4 路排队（每路秒级到十几秒），共享缺省 60s
 *  会把健康长句或排队尾判死、在途 kill 后整段重放。hang 判定语义不丢：卡死的请求最多 180s
 *  后被 kill 转 per-call，与 per-call 帧间 180s 静止判死同一条预算线。 */
const DAEMON_REQUEST_TIMEOUT_MS = 180_000;

/** daemon 计时旋钮与闲置阈值的覆写面：真机走缺省，测试收窗与缩短收割窗口 */
export interface VoxcpmDaemonTuning {
  idleMinutes?: number;
  readyTimeoutMs?: number;
  warmTimeoutMs?: number;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * daemon-first 流式合成函数工厂（热启动 S5 voxcpm 链）：优先经常驻 daemon 出块——
 * unix socket + ready 版本键三元组握手，冷启动整个 burst 只付一次、跨 CLI 调用复用，
 * 首包 0.2-0.5s 的流式优势在温态完整保留（帧序与 per-call 逐字一致）。
 *
 * 失败分级是四引擎里唯一的流式特化面（决策台账 D4）：以「首帧是否已交付消费方」划界——
 * - 首帧前任何基础设施失败（拒连/拉起死/握手不符/在途断连/超时/队满拒转）→ per-call 重放
 *   同一请求，消费方无感（与整句引擎的先例等价）；
 * - 首帧后在途断连 → 不可重放：半截音频已出声，重放即重复前缀的缺陷音频，按引擎级失败抛
 *   EngineError 交外层回退链收敛（最坏形态 = 该次调用不出完整声，出声下限不回退）。
 * 引擎级失败（error/fatal 帧）任何时点都直报不重放（同一请求 per-call 必复现）。
 * per-call 退路复用 createShimStreamSynth：daemon 上线前形态逐字保留，兜底不回退。
 */
export function createVoxcpmSynth(spec: VoxcpmLabSpec, host: Host, tuning: VoxcpmDaemonTuning = {}): VoxcpmStreamSynth {
  // 熔断句柄跨 CLI 进程经文件会合：now 走 Host 注入（测试推进假时钟免真等）
  const circuit: CircuitHandle = { path: `${spec.labDir}/daemon-failures`, now: () => host.now() };
  const session = new DaemonSession({
    label: ENGINE_LABEL,
    socketPath: `${spec.labDir}/daemon.sock`,
    pidPath: `${spec.labDir}/daemon.pid`,
    circuit,
    idleMinutes: tuning.idleMinutes ?? DAEMON_IDLE_MINUTES,
    // --lab 显式传给 daemon 形态：sock/pid/log 落位与权重指纹的 lab 根不依赖 models 推导
    spawn: (idleMinutes) =>
      host.spawnDaemon(spec.pythonPath, [spec.shimPath, "--models", spec.modelsDir, "--lab", spec.labDir, "--daemon", "--idle-minutes", String(idleMinutes)]),
    expectedVersionKey: () => ({
      protocol: DAEMON_PROTOCOL_VERSION,
      engineVersion: DAEMON_ENGINE_VERSION,
      weightsFingerprint: weightsFingerprint(spec.labDir, VOXCPM_WEIGHT_MARKERS),
    }),
    readyTimeoutMs: tuning.readyTimeoutMs ?? DAEMON_READY_TIMEOUT_MS,
    requestTimeoutMs: tuning.requestTimeoutMs ?? DAEMON_REQUEST_TIMEOUT_MS,
    ...(tuning.warmTimeoutMs !== undefined ? { warmTimeoutMs: tuning.warmTimeoutMs } : {}),
    ...(tuning.pollIntervalMs !== undefined ? { pollIntervalMs: tuning.pollIntervalMs } : {}),
  });

  // per-call 替身会话只在首次降级时装配：daemon 健康时（绝大多数调用）不该为退路付任何进程成本
  let shimSynth: VoxcpmStreamSynth | null = null;
  let nextId = 1;
  // 单消费者互斥门（与 per-call acquire 同构）：turn 由 generator finally 归还，提前 break 也算归还
  let turn: Promise<void> = Promise.resolve();

  const runViaDaemon = async function* (req: VoxcpmSynthRequest, id: number): AsyncGenerator<VoxcpmChunk> {
    // 请求帧与 per-call runStream 逐字同构（帧不动、只换传输）：control 是 voice creation 的
    // 唯一嗓形态，缺席不写键（引擎侧括号前缀逻辑以字段存在性为准）
    for await (const line of session.request(
      encodeRequest({
        id,
        text: req.text,
        refAudioPath: req.refAudioPath ?? "",
        promptText: req.promptText ?? "",
        promptLang: "auto",
        textLang: "auto",
        speedFactor: 1.0,
        ...(req.control !== null ? { control: req.control } : {}),
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
        // 劣化史清零在 yield 之前（票 04 熔断回收判据）：done 帧到达即 daemon 完整交付的证据，
        // 不等消费方取走——流式 generator 的 yield 在消费方 break 后永不恢复，
        // 清零放 yield 之后会被「收齐即断」的正常消费路径静默跳过（整句引擎无此形态）
        if (msg.done) clearCircuitFailures(circuit);
        yield { samples: decodePcm(msg.pcm), sampleRate: msg.sampleRate, done: msg.done };
        if (msg.done) return;
      }
    }
    // EOF/超时由 request 传输层抛 DaemonUnavailableError；走到这里是 done 前流自然终结的异常形态
    throw new DaemonUnavailableError(`${ENGINE_LABEL} 常驻形态：响应流在 done 帧前终结`);
  };

  return (req: VoxcpmSynthRequest): AsyncGenerator<VoxcpmChunk> => {
    let release: () => void = () => undefined;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = turn;
    turn = next;
    const id = nextId++;
    return (async function* () {
      try {
        await prev;
        let delivered = false;
        try {
          for await (const chunk of runViaDaemon(req, id)) {
            delivered = true;
            yield chunk;
          }
        } catch (error) {
          if (!(error instanceof DaemonUnavailableError)) throw error;
          if (delivered) {
            // D4 划界点：已有音频交付消费方，重放会重复前缀——基础设施失败在这里升格为
            // 引擎级失败抛出，外层回退链按「本次引擎不出声」收敛（say 的 system 嗓兜底）
            throw new EngineError(`${ENGINE_LABEL} 常驻形态在途断连且已有音频帧交付，不可重放：${messageOf(error)}`);
          }
          if (shimSynth === null) shimSynth = createShimStreamSynth(spec, host);
          yield* shimSynth(req);
        }
      } finally {
        release();
      }
    })();
  };
}
