import { EngineError } from "../errors.ts";
import type { Host } from "../host.ts";
import { decodePcm, encodeRequest, parseLine } from "./gptsovits-protocol.ts";
import { awaitShimReady, lastMeaningfulLine, sessionDeadline, spawnShimSession, setSessionActive, type ShimSession } from "./shim-session.ts";

/** 流已终止的会话错误：错误现场从 stderr 尾部取（与 shim-session 的 terminatedError 同构，label 各归引擎） */
function terminatedSessionError(current: ShimSession): EngineError {
  const last = lastMeaningfulLine(current.stderrTail);
  const suffix = last === undefined ? "" : `（stderr 末行：${last.slice(0, 300)}）`;
  return new EngineError(`VoxCPM 进程输出已终止${suffix}`);
}

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
        if (outcome.done) throw terminatedSessionError(current);
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
