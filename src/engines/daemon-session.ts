import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import net from "node:net";
import type { DaemonProcess } from "../host.ts";
import { isCircuitOpen, recordCircuitFailure, type CircuitHandle } from "./daemon-circuit.ts";

/**
 * 常驻 daemon 的 Node 侧会话面（热启动 S1，gptsovits 钉版先行）：
 * unix socket 连接、ready 版本键三元组握手、lazy 拉起编排、请求经 socket。
 * 帧协议逐字沿用 engine-protocol v1（钉死口径：帧不动、只换传输层），
 * 所以编解码复用各引擎 protocol 模块，本文件只管「连接与其生命周期」。
 * 与 shim-session（per-call 管道会话）平行存在：一个 shim 脚本双形态共存，
 * per-call 保留为 daemon 不可用时的降级路径。
 */

/** 跨调用常驻进程的基础设施层失败判据（连接拒/拉起死/握手不符/在途断连/超时）——与协议层 error 帧区分：
 * 前者降级 per-call 重放（同请求换个进程再跑一次仍可能成），后者是引擎级失败，重放必复现，不降级 */
export class DaemonUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonUnavailableError";
  }
}

/**
 * 版本握手的期望三元组：协议版本（仓内常量，shim 侧同名常量随仓升级）+
 * 引擎版本（ready.version，钉版引擎的已知值）+ 权重指纹（磁盘投影，见 weightsFingerprint）。
 * 任一不符 = 过期 daemon（旧代码拉的常驻进程），kill 重拉一次；不做热切权重——
 * 进程内存混着两套代码状态，产错音无从归因。
 */
export interface DaemonVersionKey {
  protocol: string;
  engineVersion: string;
  weightsFingerprint: string;
}

/**
 * gptsovits 权重面投影：安装期 sha256 校验通过后的 .install-ok 标记（install-engine.mjs 落位、
 * engine-status 与 gptsovitsMissingAssets 消费），marker 的 size+mtime_ns 即「这套权重何时被何版本
 * 安装」的指纹。升级重装必然重写 marker → 指纹变 → 旧 daemon 握手失效自动重拉。
 * （权威清单 hash 的落点在安装脚本、不在会话层文件域，marker 投影是其等价机制替代；
 * 清单若扩容，两处列表必须同步：本数组与 shim 的 WEIGHT_MARKERS。）
 */
export const GPTSOVITS_WEIGHT_MARKERS: readonly string[] = [
  "GPT-SoVITS/GPT_SoVITS/pretrained_models/.install-ok",
  "GPT-SoVITS/GPT_SoVITS/text/G2PWModel/.install-ok",
  "open_jtalk_dic_utf_8-1.11/.install-ok",
  "venv/nltk_data/tokenizers/punkt_tab/.install-ok",
  "venv/nltk_data/taggers/averaged_perceptron_tagger_eng/.install-ok",
  "venv/nltk_data/corpora/cmudict/.install-ok",
];

/**
 * IndexTTS 权重面投影：主权重十件的文件级 size+mtime（install-engine 逐件下载校验落位）。
 * 与 gptsovits 的 .install-ok marker 投影同构——indextts 权重是单文件形态无 archive 解压标记，
 * 文件本身的安装 mtime 即「这套权重何时被安装」的投影；升级重装重写文件 → mtime 变 → 旧 daemon
 * 握手失效自动重拉。auto 层（checkpoints/hf_cache 首跑自拉四件）刻意排除：那是引擎 fallback 链
 * 的运行时产物而非安装事件，纳入会把自拉噪声当权重变更。清单与 shim 侧 WEIGHT_MARKERS 逐条一致，
 * 由 test/daemon-fingerprint.test.ts 双实现对拍钉死；manifest 增删两处同改。
 */
export const INDEXTTS_WEIGHT_MARKERS: readonly string[] = [
  "checkpoints/gpt.pth",
  "checkpoints/codec.pth",
  "checkpoints/s2mel.pth",
  "checkpoints/qwen0.6bemo4-merge/model.safetensors",
  "checkpoints/config.yaml",
  "checkpoints/feat1.pt",
  "checkpoints/feat2.pt",
  "checkpoints/wav2vec2bert_stats.pt",
  "checkpoints/multilingual_zh_ja_yue_char_del.tiktoken",
  "index-tts/examples/voice_01.wav",
];

/**
 * FireRed 权重面投影：manifest FIRERED.weights 的 11 件文件级投影（models/FireRedTTS3 十件
 * + prompts/prompt_2.wav default 嗓参考，与 indextts 把示例参考纳入投影的先例同构）。
 * 与 shim 侧 WEIGHT_MARKERS 逐条一致，由 test/daemon-fingerprint.test.ts 双实现对拍钉死；
 * manifest 增删两处同改。firered 无 auto 层（依赖闭包恒空，安装面全量权威），无排除项。
 */
export const FIRERED_WEIGHT_MARKERS: readonly string[] = [
  "models/FireRedTTS3/fireredtts3_base/model.safetensors",
  "models/FireRedTTS3/fireredtts3_base/config.json",
  "models/FireRedTTS3/fireredtts3_instruct/model.safetensors",
  "models/FireRedTTS3/fireredtts3_instruct/config.json",
  "models/FireRedTTS3/redae/model.safetensors",
  "models/FireRedTTS3/redae/config.json",
  "models/FireRedTTS3/campp/campplus_voxceleb.bin",
  "models/FireRedTTS3/text_tokenizer/tokenizer.json",
  "models/FireRedTTS3/text_tokenizer/tokenizer_config.json",
  "models/FireRedTTS3/text_tokenizer/vocab.json",
  "prompts/prompt_2.wav",
];

/**
 * VoxCPM 权重面投影：manifest VOXCPM.weights 的 7 件文件级 size+mtime（models/ 全部）。
 * 无 default 资产嗓投影——voxcpm 的 default 嗓是 control 文本形态（无 prompt wav 资产），
 * 与 firered/indextts 把参考资产纳入清单的形态天然不同，不是遗漏。
 * 与 shim 侧 WEIGHT_MARKERS 逐条一致，由 test/daemon-fingerprint.test.ts 双实现对拍钉死；
 * manifest 增删两处同改。config.json 在列：architecture 漂移（换模型代际）必同时击穿
 * 指纹与 ready.version 运行时类名，握手拒载双路自兜。
 */
export const VOXCPM_WEIGHT_MARKERS: readonly string[] = [
  "models/model.safetensors",
  "models/audiovae.pth",
  "models/config.json",
  "models/tokenizer.json",
  "models/tokenizer_config.json",
  "models/special_tokens_map.json",
  "models/tokenization_voxcpm2.py",
];

/**
 * 权重指纹：对 marker 清单（rel 路径升序）逐条取 `rel|size|mtime_ms`（stat 失败记 `rel|missing|0`），
 * 换行连接后 sha256 hex。与 Python shim 的同名实现必须逐字节一致——
 * 跨语言公式漂移会让每次握手失败、静默永久降级 per-call，故由对拍测试钉死（daemon-fingerprint.test.ts）。
 * mtime 取毫秒而非纳秒：Node Stats 只暴露 ms 面（bigint 形态的 mtimeMs 为整毫秒 bigint），
 * Python 侧对应 `st_mtime_ns // 1_000_000`，两侧同为 floor 语义；ms 粒度对安装事件足够
 * （两次重装不可能落在同一毫秒），且避开 epoch 纳秒超 2^53 的浮点精度陷阱。
 */
export function weightsFingerprint(labDir: string, markers: readonly string[]): string {
  const lines: string[] = [];
  for (const rel of [...markers].sort()) {
    let st;
    try {
      st = statSync(join(labDir, rel), { bigint: true });
    } catch {
      lines.push(`${rel}|missing|0`);
      continue;
    }
    lines.push(`${rel}|${st.size.toString()}|${st.mtimeMs.toString()}`);
  }
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** 握手等待的帧型结局：行 / 流终止 / 超时（timeout 与 eof 都进 kill 重拉判定面） */
type FrameOutcome = { kind: "line"; line: string } | { kind: "eof" } | { kind: "timeout" };

/** 握手收妥的 ready 三元组 + 诊断面 device + daemon 自述 pid（kill 归属核对用，旧 daemon 无此字段） */
interface ReadyInfo {
  protocol: string;
  engineVersion: string;
  weightsFingerprint: string;
  device: string;
  pid: number | null;
}

export interface DaemonSessionOptions {
  /** 错误消息前缀（引擎名，per-call 会话的 label 同词） */
  label: string;
  /** `~/.local/share/say-lab/<engine>/daemon.sock`：固定众知路径，无服务发现层 */
  socketPath: string;
  /** daemon bind 后自写的 pid 文件（外部过期 daemon 的 kill 句柄；S6 `say daemon ls` 同源消费） */
  pidPath: string;
  /** 闲置收割阈值（分钟），随 spawn 参数交给 shim 自计时 */
  idleMinutes: number;
  /** lazy 拉起原语：组装 --daemon 参数经 Host.spawnDaemon，返回常驻进程句柄 */
  spawn: (idleMinutes: number) => DaemonProcess;
  /** 期望版本键：每次握手时现算（磁盘投影实时性：daemon 拉起后权重被换也能当场识破） */
  expectedVersionKey: () => DaemonVersionKey;
  /** spawn 后等可连+ready 的上限：加载本体秒级到十几秒，沿用 per-call 的 120s 余量 */
  readyTimeoutMs?: number;
  /** 既有 daemon 直连的 ready 初判：温态应即时；超时后若 pid 文件年龄仍在加载窗内按加载中续等，窗口尽才判僵死 */
  warmTimeoutMs?: number;
  /** 温态请求 deadline：纯推理秒级 + 排队余量，远小于 per-call 180s（那个含模型加载，不该套到热态） */
  requestTimeoutMs?: number;
  /** lazy 轮询可连的间隔 */
  pollIntervalMs?: number;
  /**
   * 故障熔断句柄（daemon-failures 文件）：markUnavailable 是所有基础设施失败的收敛咽喉，
   * 计数在此计入；off 与冷却直拒不走 markUnavailable 故不计数（容量事件与跳过不是劣化证据）。
   * 缺席则纯内存 sticky，跨进程闸由上层装配决定开不开。
   */
  circuit?: CircuitHandle;
}

/** 四个计时旋钮的落定形态：缺省值集中一处，注入值供测试收窗 */
interface ResolvedOptions extends DaemonSessionOptions {
  readyTimeoutMs: number;
  warmTimeoutMs: number;
  requestTimeoutMs: number;
  pollIntervalMs: number;
}

const DEFAULTS: Pick<ResolvedOptions, "readyTimeoutMs" | "warmTimeoutMs" | "requestTimeoutMs" | "pollIntervalMs"> = {
  readyTimeoutMs: 120_000,
  warmTimeoutMs: 5_000,
  requestTimeoutMs: 60_000,
  pollIntervalMs: 200,
};

/**
 * daemon 会话：一个 unix socket 连接 + 握手 + lazy 编排。
 * 生命周期语义：
 * - ensure/request 惰性触发；establish 一次成功后续复用同一连接（不再握手）。
 * - 基础设施失败（拒连超时/拉起死/握手不符/在途 EOF/请求超时）收敛为 DaemonUnavailableError；
 *   fatal 帧是确定性加载失败，不重拉（再拉只白付一次冷启动），直接交降级路径报精确原因。
 * - sticky：判 unavailable 后本实例（= 本次 CLI 调用）不再触 daemon，由调用方走 per-call；
 *   新 CLI 进程天然重试（下次调用 lazy 重拉，burst 后续条命中热 daemon）。
 * - 事件循环活性：握手与在途请求期 socket ref（合成中宿主不被提前回收），idle 期 unref
 *   （合成完成后 CLI 自然退出，daemon 经 pid/log/sock 自持生命周期——管道与 socket 断开不收走它）。
 * - 并发契约：单消费者（调用方的请求互斥链保证串行进 request）；跨进程的并发由多 CLI 各开连接、
 *   daemon 侧单飞串行消化。
 */
export class DaemonSession {
  private readonly opts: ResolvedOptions;
  private unavailable: string | null = null;
  private socket: net.Socket | null = null;
  /** 当前连接是否由本会话 spawn 而来：kill 优先用自带句柄，外部 daemon 走 pid 文件 */
  private socketFromSpawn = false;
  private spawnedProc: DaemonProcess | null = null;
  /** spawn 句柄是否仍存活：进程一死，socket 对面的 daemon 就归他人，破坏面所有权必须随之让渡
   * （bind 竞态里「先连上、后观察到 exit 3」的时序与此同构，归属按当下事实而非观察顺序） */
  private spawnedProcAlive = false;
  /** 握手期 daemon ready 帧自述的 pid：kill 前与 pid 文件核对，不符即拒 kill（防 pid 复用误杀无辜进程） */
  private peerPid: number | null = null;
  /** 单消费者行队列：Buffer 累积按 0x0a 切（逐 chunk toString 会切断多字节 UTF-8） */
  private lineBuffer: Buffer = Buffer.alloc(0);
  private readonly lineQueue: string[] = [];
  private streamEnded = false;
  private pendingResolve: ((outcome: FrameOutcome) => void) | null = null;
  private establishing: Promise<void> | null = null;
  /** attachSocket 代数：旧连接销毁的异步 close 事件不得覆写新连接的读态（重拉时序串扰防线） */
  private generation = 0;

  constructor(options: DaemonSessionOptions) {
    this.opts = { ...DEFAULTS, ...options };
  }

  get unavailableReason(): string | null {
    return this.unavailable;
  }

  /** 确保存在「已建立且握手通过」的连接；并发 ensure 共享同一次 establish */
  async ensure(): Promise<void> {
    if (this.unavailable !== null) {
      throw new DaemonUnavailableError(`${this.opts.label} 常驻形态本次调用不再尝试：${this.unavailable}`);
    }
    if (this.socket !== null && !this.socket.destroyed && !this.streamEnded) return;
    // 冷却闸只拦「新建立」：已有活连接照常复用（开窗后在途请求该出多少声出多少声）。
    // 直拒不走 markUnavailable：冷却跳过不是新的劣化证据，也不该污染 sticky
    if (this.opts.circuit !== undefined && isCircuitOpen(this.opts.circuit)) {
      throw new DaemonUnavailableError(`${this.opts.label} 常驻形态熔断冷却中（近期连续失败），本次直接走 per-call`);
    }
    if (this.establishing !== null) {
      await this.establishing;
      return;
    }
    const run = this.establish().finally(() => {
      this.establishing = null;
    });
    this.establishing = run;
    await run;
  }

  /**
   * 发送一帧请求并逐行产出协议帧。EOF（daemon 在途死掉）与超时都转 DaemonUnavailableError——
   * 超时即 kill daemon（hang 的进程占着内存又不出声，留着只让后续调用继续撞）。
   * 消费方 break 早退即收束（终结帧到达），连接留给下一次 request。
   */
  async *request(line: string): AsyncGenerator<string> {
    await this.ensure();
    const socket = this.socket;
    if (socket === null || socket.destroyed) {
      throw new DaemonUnavailableError(`${this.opts.label} 常驻形态：连接不可用`);
    }
    socket.ref();
    try {
      socket.write(line);
      const start = Date.now();
      for (;;) {
        const remaining = this.opts.requestTimeoutMs - (Date.now() - start);
        if (remaining <= 0) break;
        const outcome = await this.waitFrame(remaining);
        if (outcome.kind === "line") {
          yield outcome.line;
          continue;
        }
        if (outcome.kind === "timeout") {
          await this.killDaemon();
          this.markUnavailable(`请求超时（>${Math.round(this.opts.requestTimeoutMs / 1000)}s），已终止 daemon`);
          throw new DaemonUnavailableError(`${this.opts.label} 常驻形态不可用：请求超时`);
        }
        this.markUnavailable("daemon 在途连接断开（EOF）");
        throw new DaemonUnavailableError(`${this.opts.label} 常驻形态不可用：daemon 在途连接断开`);
      }
      await this.killDaemon();
      this.markUnavailable(`请求超时（>${Math.round(this.opts.requestTimeoutMs / 1000)}s），已终止 daemon`);
      throw new DaemonUnavailableError(`${this.opts.label} 常驻形态不可用：请求超时`);
    } finally {
      this.socket?.unref();
    }
  }

  /** 只关客户端连接不收 daemon：daemon 生命周期归 idle/SIGTERM/kill */
  close(): void {
    this.detachSocket();
  }

  /**
   * kill daemon：spawn 句柄优先（自己拉的自己收），否则 pid 文件（外部 daemon）；
   * kill 后 unlink sock/pid：过期进程的残file挡路重拉（多 CLI 并发拉起的竞态仲裁另行完善）。
   * 外部 pid 场景的归属核对：ready 自述 pid 与 pid 文件不符即拒 kill 拒 unlink——pid 文件可能
   * 指向被复用的无辜进程、sock 可能是另一活 daemon 的注册点，不确定就不动 destructive 面。
   */
  async killDaemon(): Promise<"killed" | "skipped"> {
    const spawnedPid = this.socketFromSpawn ? (this.spawnedProc?.pid ?? null) : null;
    const pidFile = await this.readPidFile();
    // spawn 句柄的归属非终身制：拉起后到 kill 决策前，注册点可能被他人 unlink-rebind 接管
    // （backlog 排满的 ECONNREFUSED 被误判残file等交错）。pid 文件仍指自己 proc 才走 owned：
    // 收自己进程、清自己文件。一旦不指自己，这条 socket 对面的 daemon 归属他人，
    // 完整让渡 external 路径（经归属核对 kill 在位者 + 清其注册点）——半程弃权会把
    // 「kill 过期 daemon 后重拉」的两轮制收敛打断成「文件挡路、轮次耗尽」
    if (spawnedPid !== null && pidFile !== null && pidFile !== spawnedPid) {
      this.socketFromSpawn = false;
    }
    if (this.socketFromSpawn) {
      if (spawnedPid !== null) {
        try {
          process.kill(spawnedPid, "SIGKILL");
        } catch {
          // 进程已死：kill 失败无意义，残file清理由下面兜住
        }
      }
      await unlinkQuiet(this.opts.socketPath);
      await unlinkQuiet(this.opts.pidPath);
      this.detachSocket();
      return "killed";
    }
    if (this.peerPid !== null && pidFile !== null && this.peerPid !== pidFile) {
      this.detachSocket();
      return "skipped";
    }
    if (pidFile !== null) {
      try {
        process.kill(pidFile, "SIGKILL");
      } catch {
        // 同上
      }
    }
    await unlinkQuiet(this.opts.socketPath);
    await unlinkQuiet(this.opts.pidPath);
    this.detachSocket();
    return "killed";
  }

  private markUnavailable(reason: string): void {
    this.unavailable = reason;
    // 熔断计数的唯一咽喉：establish/spawnAndWait/request 所有基础设施失败都收敛到这里，
    // 拉起失败、握手不符、在途 EOF、请求超时 kill 天然全覆盖（票 04 计数事件集合）
    if (this.opts.circuit !== undefined) recordCircuitFailure(this.opts.circuit);
    this.detachSocket();
  }

  private detachSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.socketFromSpawn = false;
    if (socket !== null && !socket.destroyed) socket.destroy();
  }

  /** establish 两轮制：首轮现场判、僵死/过期 kill 后重拉一次封顶（封顶防无限拉起循环） */
  private async establish(): Promise<void> {
    let lastReason = "握手反复失败";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let socket: net.Socket | "need-spawn";
      let spawnedNow = false;
      let loserMode = false;
      // 轮内共享预算：可连轮询与 ready 握手合计不超 readyTimeoutMs（两段各自满额会让
      // bind 即成但 ready 永不到场的僵死 daemon 静默挂近 2×120s，远超文档口径）
      const roundStart = Date.now();
      const connect = await this.tryConnect();
      if (connect === "refused") {
        await unlinkQuiet(this.opts.socketPath); // 残file无人监听：挡 bind 也挡复用，清掉转拉起
        socket = "need-spawn";
      } else if (connect === "absent") {
        socket = "need-spawn";
      } else {
        socket = connect;
      }
      if (socket === "need-spawn") {
        const spawned = await this.spawnAndWait(); // 失败路径内部 markUnavailable 并抛，不返回
        socket = spawned.socket;
        spawnedNow = true;
        // bind 竞态输家：探针判负 exit 3，或「先连上后观察到句柄退场」——两种时序同义，
        // 这条连接对面的进程都不归本会话，破坏面所有权让渡给 pid 文件归属核对
        loserMode = spawned.loser || !this.spawnedProcAlive;
        lastReason = "握手未通过";
      }
      const handshakeBudget = spawnedNow ? Math.max(1, this.opts.readyTimeoutMs - (Date.now() - roundStart)) : this.opts.warmTimeoutMs;
      // 加载宽限只对 warm 直连开：spawn 自拉的连接其预算本就已含整个加载窗，再宽限是双重计时
      const graceCheck = spawnedNow ? undefined : (): Promise<number | null> => this.warmLoadingGraceMs();
      const outcome = await this.handshake(socket, handshakeBudget, graceCheck);
      if (outcome.kind === "ready") {
        const expected = this.opts.expectedVersionKey();
        const got = outcome.info;
        if (got.protocol === expected.protocol && got.engineVersion === expected.engineVersion && got.weightsFingerprint === expected.weightsFingerprint) {
          this.settleSocket(socket, spawnedNow && !loserMode && this.spawnedProcAlive, got.pid);
          return;
        }
        // 不符也要记下对端自述 pid：kill 归属核对对「拒收的 ready」同样适用
        this.peerPid = got.pid;
        lastReason = `版本键不符（daemon: protocol=${got.protocol} version=${got.engineVersion} weights=${got.weightsFingerprint.slice(0, 12)}… / 期望 protocol=${expected.protocol} version=${expected.engineVersion} weights=${expected.weightsFingerprint.slice(0, 12)}…）`;
      } else if (outcome.kind === "fatal") {
        // 确定性加载失败：再拉只是再付一次冷启动，直接把原因交降级链（per-call 会报出同一 fatal）
        this.detachSocket();
        this.markUnavailable(`daemon 加载失败：${outcome.message}`);
        throw new DaemonUnavailableError(`${this.opts.label} 常驻形态不可用：daemon 加载失败（${outcome.message}）`);
      } else {
        lastReason = outcome.kind === "timeout" ? `ready 等待超时（>${Math.round((spawnedNow ? this.opts.readyTimeoutMs : this.opts.warmTimeoutMs) / 1000)}s）` : "握手期连接已终止（EOF）";
      }
      // 迟到的 exit 3 仲裁窗：输家探针判负可能晚于 sock 可连到达（bind 竞态的交叠窗口——
      // 他人刚 bind 完而我们spawn的输家还没退出场）。失败处置期proc若以 3 退场，
      // 这条连接对面归属他人：转输家语义走 pid 文件核对，避免 owned 句柄空杀+误unlink赢家注册点。
      // 只在失败路径付这个观察成本：ready 相符的复用路径若对面真是输家连接，破坏面归属由 settle 的 alive 复查兜住
      if (spawnedNow && !loserMode && this.spawnedProc !== null) {
        const late = await Promise.race([this.spawnedProc.exit, delay(this.opts.pollIntervalMs).then(() => null)]);
        if (late !== null && late.exitCode === 3) {
          loserMode = true;
          this.spawnedProcAlive = false; // proc.exit 已 resolve 但 then 回调未必轮到：手动坐实，防下游 alive 误判
        }
      }
      // 僵死/过期形态：kill + unlink 后重拉一次（第二轮仍如此即封顶）。
      // kill 归属现场钉定：本轮连接来自 spawn 且非输家才用自带句柄；输家与外部 daemon 一律走 pid 文件
      // ——输家自己的 spawn 句柄已以 exit 3 退场，拿它 kill 只会空杀自己、再 unlink 掉赢家的注册点
      this.socket = socket;
      this.socketFromSpawn = spawnedNow && !loserMode;
      if ((await this.killDaemon()) === "skipped") {
        lastReason = "daemon 自述 pid 与 pid 文件不符（pid 复用或双 daemon 并存），拒 kill 拒清其文件";
        break;
      }
    }
    this.markUnavailable(lastReason);
    throw new DaemonUnavailableError(`${this.opts.label} 常驻形态不可用：${lastReason}`);
  }

  /**
   * spawn 后轮询可连。退出码是分水岭：非 3 的早退按拉起失败收敛（抛错），
   * exit 3 是 shim 探针判负「他人在位」——本会话转成输家，继续轮询 connect 等赢家可连
   * （上限 = 加载窗 readyTimeoutMs），且此后对这条连接不做破坏面：进程与 sock 都归他人。
   */
  private async spawnAndWait(): Promise<{ socket: net.Socket; loser: boolean }> {
    const proc = this.opts.spawn(this.opts.idleMinutes);
    this.spawnedProc = proc;
    this.socketFromSpawn = true;
    this.spawnedProcAlive = true;
    void proc.exit.then(() => {
      this.spawnedProcAlive = false;
    });
    setStreamsActive(proc, false); // 常驻进程不拖宿主事件循环（同 shim-session 的 idle 纪律）
    const start = Date.now();
    let loserSeen = false;
    for (;;) {
      const connect = await this.tryConnect();
      if (connect !== "absent" && connect !== "refused") {
        return { socket: connect, loser: loserSeen };
      }
      if (connect === "refused") {
        await unlinkQuiet(this.opts.socketPath); // bind 与残file竞态窗口：清掉继续等
      }
      if (loserSeen) {
        await delay(this.opts.pollIntervalMs); // 输家句柄已退场，没有再对赌的死亡信号，轮询自带节流
      } else {
        const exitOutcome = await Promise.race([proc.exit, delay(this.opts.pollIntervalMs).then(() => null)]);
        if (exitOutcome !== null) {
          if (exitOutcome.exitCode === 3) {
            loserSeen = true; // 探针判负转等待；不能用 died-early 分支，加载中赢家误杀实证就是这条路径
          } else {
            const why = this.spawnedProc === null ? "拉起失败" : "拉起失败（进程先于可连退出）";
            this.markUnavailable(why);
            throw new DaemonUnavailableError(`${this.opts.label} 常驻形态不可用：${why}`);
          }
        }
      }
      if (Date.now() - start >= this.opts.readyTimeoutMs) {
        if (loserSeen) {
          // 输家超时：加载窗内赢家始终不可连（探针与 bind 之间它死了），按缺席降级——
          // 不 kill 不 unlink：他人的残file留给下一个拉起者的 unlink-rebind 处理
          this.markUnavailable("bind 竞态输家：等待在位 daemon 可连超加载窗上限");
          throw new DaemonUnavailableError(`${this.opts.label} 常驻形态不可用：bind 竞态输家等待可连超时`);
        }
        // 超上限仍不可连：杀掉自己拉起的进程兜底（它可能卡在加载）
        await this.killDaemon();
        this.markUnavailable(`ready 等待超时（>${Math.round(this.opts.readyTimeoutMs / 1000)}s）`);
        throw new DaemonUnavailableError(`${this.opts.label} 常驻形态不可用：daemon 拉起后迟迟不可连`);
      }
    }
  }

  /**
   * 读到 ready/fatal；杂散行丢弃（引擎库 print 混流的既有形态）；返回 timeout/eof 交调用方进 kill 重拉判定。
   * graceCheck 至多触发一次：初判到期仍未 ready 时，回调给「继续等的毫秒数」就同连接续读——
   * bind 先于加载的赢家与僵死 daemon 在握手面不可分辨，加载窗内先当加载中（S2 竞态仲裁）。
   */
  private async handshake(socket: net.Socket, timeoutMs: number, graceCheck?: () => Promise<number | null>): Promise<{ kind: "ready"; info: ReadyInfo } | { kind: "fatal"; message: string } | { kind: "timeout" } | { kind: "eof" }> {
    this.attachSocket(socket);
    const start = Date.now();
    let deadline = start + timeoutMs;
    let graced = false;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        if (!graced && graceCheck !== undefined) {
          graced = true;
          const extraMs = await graceCheck();
          if (extraMs !== null && extraMs > 0) {
            deadline = Date.now() + extraMs;
            continue;
          }
        }
        return { kind: "timeout" };
      }
      const outcome = await this.waitFrame(remaining);
      if (outcome.kind === "eof") return { kind: "eof" };
      if (outcome.kind === "timeout") continue; // 帧等待到期不等于整体到期：回环顶按 deadline 与宽限再判
      const trimmed = outcome.line.trim();
      if (trimmed.length === 0) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(trimmed);
      } catch {
        continue; // 杂散输出：丢弃继续读
      }
      if (typeof raw !== "object" || raw === null) continue;
      const msg = raw as Record<string, unknown>;
      if (msg.type === "fatal" && typeof msg.message === "string") return { kind: "fatal", message: msg.message };
      if (msg.type !== "ready") continue;
      const pid = typeof msg.pid === "number" ? msg.pid : null;
      if (typeof msg.protocol !== "string" || typeof msg.version !== "string" || typeof msg.weights_fingerprint !== "string") {
        // ready 缺版本键字段 = 握手前的旧 shim 形态 daemon：判过期（不符语义走调用方比较前直接报）
        return { kind: "ready", info: { protocol: String(msg.protocol ?? ""), engineVersion: String(msg.version ?? ""), weightsFingerprint: String(msg.weights_fingerprint ?? ""), device: String(msg.device ?? ""), pid } };
      }
      return { kind: "ready", info: { protocol: msg.protocol, engineVersion: msg.version, weightsFingerprint: msg.weights_fingerprint, device: msg.device === undefined ? "" : String(msg.device), pid } };
    }
  }

  private settleSocket(socket: net.Socket, fromSpawn: boolean, peerPid: number | null): void {
    this.socket = socket;
    this.socketFromSpawn = fromSpawn;
    this.peerPid = peerPid;
    socket.unref(); // 握手完成即归还事件循环：request 期再 ref
  }

  /** 连接错误语义分类：ENOENT=缺席可拉起；拒连=残file；其余按缺席保守转拉起 */
  private tryConnect(): Promise<net.Socket | "absent" | "refused"> {
    return new Promise((resolve) => {
      const sock = net.connect(this.opts.socketPath);
      sock.once("connect", () => {
        sock.removeAllListeners("error");
        resolve(sock);
      });
      sock.once("error", (error) => {
        sock.destroy();
        const code = (error as NodeJS.ErrnoException).code;
        resolve(code === "ECONNREFUSED" ? "refused" : "absent");
      });
    });
  }

  private attachSocket(socket: net.Socket): void {
    socket.setNoDelay(true);
    this.lineBuffer = Buffer.alloc(0);
    this.lineQueue.length = 0;
    this.streamEnded = false;
    this.peerPid = null; // 归属自述只对当前连接有效，换连接即失效
    const gen = ++this.generation;
    const mine = () => this.generation === gen; // 旧 socket 的迟发事件直接弃听
    socket.on("data", (chunk: Buffer) => {
      if (!mine()) return;
      this.lineBuffer = this.lineBuffer.length === 0 ? chunk : Buffer.concat([this.lineBuffer, chunk]);
      for (;;) {
        const cut = this.lineBuffer.indexOf(0x0a);
        if (cut < 0) break;
        const line = this.lineBuffer.subarray(0, cut).toString("utf8");
        this.lineBuffer = this.lineBuffer.subarray(cut + 1);
        this.pushLine(line);
      }
    });
    const ended = () => {
      if (!mine()) return;
      if (this.lineBuffer.length > 0) {
        this.pushLine(this.lineBuffer.toString("utf8"));
        this.lineBuffer = Buffer.alloc(0);
      }
      this.streamEnded = true;
      this.pendingResolve?.({ kind: "eof" });
    };
    socket.once("end", ended);
    socket.once("close", ended);
    socket.on("error", () => {
      /* 死亡结局统一由 close/end 收敛（同 host.spawnDaemon 对 EPIPE 的吞法） */
    });
  }

  /** 有新行即唤醒等待者；无等待者先入队（attach 与 waitFrame 注册之间有天然到达窗口，积压不能丢） */
  private pushLine(line: string): void {
    // 必须在调用前取引用并判空：finish 解决时自己清 pendingResolve，
    // 若先置 null 再调用，finish 的重入守卫（pendingResolve !== wake）会把唤醒吞掉
    const wake = this.pendingResolve;
    if (wake !== null) {
      wake({ kind: "line", line });
    } else {
      this.lineQueue.push(line);
    }
  }

  /** 单消费帧等待：优先队列积压，其次事件驱动，计时器仅计时不保活 */
  private waitFrame(timeoutMs: number): Promise<FrameOutcome> {
    return new Promise((resolve) => {
      if (this.lineQueue.length > 0) {
        resolve({ kind: "line", line: this.lineQueue.shift() ?? "" });
        return;
      }
      if (this.streamEnded) {
        resolve({ kind: "eof" });
        return;
      }
      const finish = (outcome: FrameOutcome): void => {
        if (this.pendingResolve !== wake) return;
        this.pendingResolve = null;
        clearTimeout(timer);
        resolve(outcome);
      };
      const wake = finish;
      this.pendingResolve = wake;
      const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
      timer.unref();
    });
  }

  /**
   * warm 直连 ready 初判到期后的加载宽限毫秒数：shim bind 成功即写 pid 文件（≈加载起点），
   * pid 文件年龄还在加载窗内 = 对面可能只是加载中的赢家 → 续等剩余窗；
   * 窗口耗尽仍无 ready = 僵死终态 → 照旧 kill 重拉（取代 S1「warm 5s 即杀」——真机实证
   * 后来者会误杀加载中的赢家，宽限把 kill 推到窗口尽，僵死语义不丢只顺延）。
   * pid 文件缺失或年龄为负（时钟异常）不给宽限，维持初判即杀。
   */
  private async warmLoadingGraceMs(): Promise<number | null> {
    try {
      const st = await stat(this.opts.pidPath);
      const ageMs = Date.now() - st.mtimeMs;
      if (ageMs < 0) return null;
      return ageMs < this.opts.readyTimeoutMs ? this.opts.readyTimeoutMs - ageMs : null;
    } catch {
      return null;
    }
  }

  private async readPidFile(): Promise<number | null> {
    try {
      const text = await readFile(this.opts.pidPath, "utf8");
      const pid = Number.parseInt(text.trim(), 10);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }
}

async function unlinkQuiet(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // 权限/占用类失败不反杀调用方：残file清不掉由下一个拉起者兜（S2 完善探活）
    }
  }
}

/** lazy 拉起轮询的活动等待：必须 ref 保活。真机实证——unref 计时器 + 已 unref 的 child +
 * 不持循环的 exit promise 三者叠加，轮询窗口内宿主事件循环完全空心，Node 静默 exit 0 不出声
 * （vitest 替身环境由 runner 持活循环，此洞测不出，只能真机暴露） */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 管道流活性开关（与 shim-session 的 setStreamActive 同语义；fake 流缺方法静默跳过） */
function setStreamsActive(proc: DaemonProcess, active: boolean): void {
  const streams: unknown[] = [proc.stdin, proc.stdout, proc.stderr];
  for (const stream of streams) {
    const refable = stream as { ref?: () => void; unref?: () => void };
    if (active) refable.ref?.();
    else refable.unref?.();
  }
}
