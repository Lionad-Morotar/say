import net from "node:net";
import type { DaemonEngine } from "./config.ts";
import { sayLabEngineDir } from "./paths.ts";
import type { Host } from "./host.ts";
import type { EnvMap } from "./types.ts";
import type { DaemonVersionKey } from "./engines/daemon-session.ts";
import { DAEMON_READY_TIMEOUT_MS as GPTSOVITS_READY_MS, expectedDaemonVersionKey as gptsovitsVersionKey } from "./engines/gptsovits-binding.ts";
import { DAEMON_READY_TIMEOUT_MS as INDEXTTS_READY_MS, expectedDaemonVersionKey as indexttsVersionKey } from "./engines/indextts-binding.ts";
import { DAEMON_READY_TIMEOUT_MS as FIRERED_READY_MS, expectedDaemonVersionKey as fireredVersionKey } from "./engines/firered-binding.ts";
import { DAEMON_READY_TIMEOUT_MS as VOXCPM_READY_MS, expectedDaemonVersionKey as voxcpmVersionKey } from "./engines/voxcpm-binding.ts";

/**
 * 常驻 daemon 的只读观测面（热启动 S6 `say daemon ls`）：连接 + ready 帧握手探测，
 * 与 session 的差异是纪律——不 kill、不 unlink、不拉起、不清残file。
 * 观测的每次误杀都会把健康 daemon 变成一次冷启动，只读性是这条命令的存在前提。
 */

/** 六态判据：warm 握手相符；loading 可连未 ready 且进程龄在加载窗内；stale 握手三元组不符（下次调用自动 kill 重拉）；
 *  unreachable 注册点在但服务不可达（残file/僵死/fatal）；idle 无注册点无常驻；zombie pid 在位而 sock 缺席 */
export type DaemonProbeState = "warm" | "loading" | "stale" | "unreachable" | "idle" | "zombie";

export interface DaemonPaths {
  labDir: string;
  sockPath: string;
  pidPath: string;
  logPath: string;
}

/** 注册点三件（sock/pid/log）与 binding/session 的落位逐字同源：lab 根经 XDG data 推导 */
export function daemonPathsOf(env: EnvMap, engine: DaemonEngine): DaemonPaths {
  const labDir = sayLabEngineDir(env, engine);
  return { labDir, sockPath: `${labDir}/daemon.sock`, pidPath: `${labDir}/daemon.pid`, logPath: `${labDir}/daemon.log` };
}

/** 各引擎握手权威面的登记表：版本键投影与加载窗都取自 binding 导出，观测判据不留第二份真源 */
const ADMIN: Readonly<Record<DaemonEngine, { versionKey: (labDir: string) => DaemonVersionKey; readyWindowMs: number }>> = {
  gptsovits: { versionKey: gptsovitsVersionKey, readyWindowMs: GPTSOVITS_READY_MS },
  indextts: { versionKey: indexttsVersionKey, readyWindowMs: INDEXTTS_READY_MS },
  firered: { versionKey: fireredVersionKey, readyWindowMs: FIRERED_READY_MS },
  voxcpm: { versionKey: voxcpmVersionKey, readyWindowMs: VOXCPM_READY_MS },
};

export interface DaemonStatusRow {
  engine: DaemonEngine;
  state: DaemonProbeState;
  pid: number | null;
  /** ps 观测的常驻内存（KB）；进程死或 ps 不可用为 null */
  rssKb: number | null;
  /** ps etime 原文（[[dd-]hh:]mm:ss）；不可用为 null */
  etime: string | null;
  /** 一行归因：版本/设备自述或不达标形态的原因 */
  note: string;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 存在但属他人（探测者无权问津生死之外的事）；ESRCH 之外按死
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** pid 文件行读取：缺失/损坏归 null，损坏同时留归因 */
export async function readDaemonPid(host: Host, pidPath: string): Promise<number | null> {
  if (!host.fileExists(pidPath)) return null;
  try {
    const pid = Number.parseInt((await host.readFileText(pidPath)).trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** ps 单行取 rss 与 etime：进程恰好在此期间退场时 ps 空输出归 null（调用方按无信息渲染） */
async function procInfoOf(host: Host, pid: number): Promise<{ rssKb: number; etime: string } | null> {
  try {
    const outcome = await host.spawn("ps", ["-o", "rss=,etime=", "-p", String(pid)]);
    if (outcome.exitCode !== 0) return null;
    const line = outcome.stdout.split("\n").map((row) => row.trim()).find((row) => row.length > 0);
    if (line === undefined) return null;
    const [rssText, etimeText] = line.split(/\s+/);
    const rssKb = Number.parseInt(rssText ?? "", 10);
    if (!Number.isInteger(rssKb) || etimeText === undefined) return null;
    return { rssKb, etime: etimeText };
  } catch {
    return null;
  }
}

/** BSD etime（[[dd-]hh:]mm:ss）→ 秒；解析失败归 null（宁可少一档判定不误判龄期） */
export function etimeToSeconds(etime: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime);
  if (m === null) return null;
  const [, daysText, hoursText, minutesText, secondsText] = m;
  const days = daysText !== undefined ? Number(daysText) * 86400 : 0;
  const hours = hoursText !== undefined ? Number(hoursText) * 3600 : 0;
  return days + hours + Number(minutesText) * 60 + Number(secondsText);
}

/** sock 帧探测结局：与 session 的 handshake 同型但更浅——只认第一张 ready/fatal，杂散行继续读 */
type SockProbe =
  | { kind: "ready"; frame: Record<string, unknown> }
  | { kind: "fatal"; message: string }
  | { kind: "refused" }
  | { kind: "eof" }
  | { kind: "timeout" };

export function probeDaemonSock(sockPath: string, timeoutMs = 2_000): Promise<SockProbe> {
  return new Promise((resolve) => {
    const conn = net.connect(sockPath);
    let buf: Buffer = Buffer.alloc(0);
    let done = false;
    const finish = (probe: SockProbe): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      conn.destroy();
      resolve(probe);
    };
    const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    timer.unref(); // 观测面不拖宿主事件循环（与 daemon-session 的 idle 纪律同族）
    conn.on("connect", () => {
      conn.setNoDelay(true);
    });
    conn.on("data", (chunk: Buffer) => {
      // Buffer 累积按 \n 切行再 toString：逐 chunk toString 会切断多字节 UTF-8（S1 传输面教训）
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      for (;;) {
        const cut = buf.indexOf(0x0a);
        if (cut < 0) break;
        const line = buf.subarray(0, cut).toString("utf8").trim();
        buf = buf.subarray(cut + 1);
        if (line.length === 0) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          continue; // 引擎库 print 混流的既有形态：与 session 丢弃面一致
        }
        if (typeof raw !== "object" || raw === null) continue;
        const msg = raw as Record<string, unknown>;
        if (msg.type === "ready") finish({ kind: "ready", frame: msg });
        else if (msg.type === "fatal") finish({ kind: "fatal", message: String(msg.message ?? "未知加载失败") });
      }
    });
    // 加载中的 daemon 会挂住不回报文直到 ready：ready 前的 EOF 即僵死注册点
    conn.on("end", () => finish({ kind: "eof" }));
    conn.on("close", () => finish({ kind: "eof" }));
    conn.once("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      finish({ kind: code === "ECONNREFUSED" ? "refused" : "eof" });
    });
  });
}

/**
 * 单引擎只读探测。设计约束：
 * - ready 等待只给短预算（缺省 2s）：真加载中的 daemon 由「pid 龄 < 引擎加载窗」判 loading，
 *   绝不在 ls 里等满 240s——ls 的耗时上限是秒级承诺；
 * - 版本键比对用 binding 权威投影（含权重指纹磁盘现算）：不符判 stale，kill 重拉归下次合成调用。
 */
export async function probeDaemonStatus(host: Host, engine: DaemonEngine, readyProbeMs = 2_000): Promise<DaemonStatusRow> {
  const { labDir, sockPath, pidPath } = daemonPathsOf(host.env, engine);
  const pid = await readDaemonPid(host, pidPath);
  const alive = pid !== null && isPidAlive(pid);
  const proc = alive && pid !== null ? await procInfoOf(host, pid) : null;
  const rssKb = proc?.rssKb ?? null;
  const etime = proc?.etime ?? null;
  const base = { engine, pid: alive ? pid : null, rssKb, etime };

  if (!host.fileExists(sockPath)) {
    if (alive) return { ...base, state: "zombie", note: "pid 在位而 sock 缺席：注册点脱落的常驻体，stop 可按 pid 收" };
    return { ...base, state: "idle", pid: null, note: "无常驻，下次 say 调用 lazy 拉起" };
  }

  const probe = await probeDaemonSock(sockPath, readyProbeMs);
  if (probe.kind === "refused") return { ...base, state: "unreachable", note: "残file 无人监听：下次调用 unlink-rebind 顶替" };
  if (probe.kind === "eof") return { ...base, state: "unreachable", note: "连上即断：僵死注册点，下次调用清理" };
  if (probe.kind === "fatal") return { ...base, state: "unreachable", note: `加载 fatal（${probe.message}）：daemon 自退中，本次合成降级 per-call` };
  if (probe.kind === "timeout") {
    const ageSec = etime !== null ? etimeToSeconds(etime) : null;
    if (alive && ageSec !== null && ageSec * 1000 < ADMIN[engine].readyWindowMs) {
      return { ...base, state: "loading", note: `bind 先于加载：加载窗 ${Math.round(ADMIN[engine].readyWindowMs / 1000)}s 内，稍后再 ls` };
    }
    return { ...base, state: "unreachable", note: alive ? "pid 在位但 ready 迟迟不到且龄超加载窗：判僵死，stop 可强收" : "sock 在位但无人应答" };
  }

  const expected = ADMIN[engine].versionKey(labDir);
  const got = probe.frame;
  const version = typeof got.version === "string" ? got.version : "?";
  const device = typeof got.device === "string" ? got.device : "?";
  if (got.protocol !== expected.protocol || version !== expected.engineVersion || got.weights_fingerprint !== expected.weightsFingerprint) {
    return { ...base, state: "stale", note: `版本键不符（daemon protocol=${String(got.protocol ?? "?")} version=${version}）：下次调用 kill 重拉` };
  }
  return { ...base, state: "warm", note: `v=${version} device=${device}` };
}
