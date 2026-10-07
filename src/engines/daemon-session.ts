import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import net from "node:net";
import type { DaemonProcess } from "../host.ts";

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
  /** 既有 daemon 直连的 ready 等待：温态应即时，长等即僵死判据 */
  warmTimeoutMs?: number;
  /** 温态请求 deadline：纯推理秒级 + 排队余量，远小于 per-call 180s（那个含模型加载，不该套到热态） */
  requestTimeoutMs?: number;
  /** lazy 轮询可连的间隔 */
  pollIntervalMs?: number;
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
    if (this.socketFromSpawn) {
      const pid = this.spawnedProc?.pid ?? null;
      if (pid !== null) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // 进程已死：kill 失败无意义，残file清理由下面兜住
        }
      }
    } else {
      const pidFile = await this.readPidFile();
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
    }
    await unlinkQuiet(this.opts.socketPath);
    await unlinkQuiet(this.opts.pidPath);
    this.detachSocket();
    return "killed";
  }

  private markUnavailable(reason: string): void {
    this.unavailable = reason;
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
        socket = await this.spawnAndWait(); // 失败路径内部 markUnavailable 并抛，不返回
        spawnedNow = true;
        lastReason = "握手未通过";
      }
      const handshakeBudget = spawnedNow ? Math.max(1, this.opts.readyTimeoutMs - (Date.now() - roundStart)) : this.opts.warmTimeoutMs;
      const outcome = await this.handshake(socket, handshakeBudget);
      if (outcome.kind === "ready") {
        const expected = this.opts.expectedVersionKey();
        const got = outcome.info;
        if (got.protocol === expected.protocol && got.engineVersion === expected.engineVersion && got.weightsFingerprint === expected.weightsFingerprint) {
          this.settleSocket(socket, spawnedNow, got.pid);
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
      // 僵死/过期形态：kill + unlink 后重拉一次（第二轮仍如此即封顶）。
      // kill 归属现场钉定：本轮连接来自 spawn 就用自带句柄，外部 daemon 走 pid 文件；
      // pid 归属核对不过（skipped）即封顶——重拉会撞同一堵墙，空转只会拉长静默
      this.socket = socket;
      this.socketFromSpawn = spawnedNow;
      if ((await this.killDaemon()) === "skipped") {
        lastReason = "daemon 自述 pid 与 pid 文件不符（pid 复用或双 daemon 并存），拒 kill 拒清其文件";
        break;
      }
    }
    this.markUnavailable(lastReason);
    throw new DaemonUnavailableError(`${this.opts.label} 常驻形态不可用：${lastReason}`);
  }

  /** spawn 后轮询可连：进程先退/超 ready 上限都按拉起失败收敛（抛错），不无限等 */
  private async spawnAndWait(): Promise<net.Socket> {
    const proc = this.opts.spawn(this.opts.idleMinutes);
    this.spawnedProc = proc;
    this.socketFromSpawn = true;
    setStreamsActive(proc, false); // 常驻进程不拖宿主事件循环（同 shim-session 的 idle 纪律）
    const start = Date.now();
    for (;;) {
      const connect = await this.tryConnect();
      if (connect !== "absent" && connect !== "refused") {
        return connect;
      }
      if (connect === "refused") {
        await unlinkQuiet(this.opts.socketPath); // bind 与残file竞态窗口：清掉继续等
      }
      const died = await Promise.race([proc.exit.then(() => true), delay(this.opts.pollIntervalMs).then(() => false)]);
      if (died) {
        const why = this.spawnedProc === null ? "拉起失败" : "拉起失败（进程先于可连退出）";
        this.markUnavailable(why);
        throw new DaemonUnavailableError(`${this.opts.label} 常驻形态不可用：${why}`);
      }
      if (Date.now() - start >= this.opts.readyTimeoutMs) {
        // 超上限仍不可连：杀掉自己拉起的进程兜底（它可能卡在加载）
        await this.killDaemon();
        this.markUnavailable(`ready 等待超时（>${Math.round(this.opts.readyTimeoutMs / 1000)}s）`);
        throw new DaemonUnavailableError(`${this.opts.label} 常驻形态不可用：daemon 拉起后迟迟不可连`);
      }
    }
  }

  /** 读到 ready/fatal；杂散行丢弃（引擎库 print 混流的既有形态）；返回 timeout/eof 交调用方进 kill 重拉判定 */
  private async handshake(socket: net.Socket, timeoutMs: number): Promise<{ kind: "ready"; info: ReadyInfo } | { kind: "fatal"; message: string } | { kind: "timeout" } | { kind: "eof" }> {
    this.attachSocket(socket);
    const start = Date.now();
    for (;;) {
      const remaining = timeoutMs - (Date.now() - start);
      if (remaining <= 0) return { kind: "timeout" };
      const outcome = await this.waitFrame(remaining);
      if (outcome.kind !== "line") return { kind: outcome.kind };
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
