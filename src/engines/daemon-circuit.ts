import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * daemon 故障熔断（票 04 崩溃自愈段的跨进程面）：常驻形态的拉起/握手/在途失败
 * 累计进 `<lab>/daemon-failures`，滑动窗内攒满阈值即开冷却闸——冷却期会话入口直拒，
 * 请求不碰 daemon 直接走 per-call。防「持续劣化时反复拉起比直接降级更糟」：
 * 拉起是分钟级成本，降级只付一次冷启动。
 *
 * 尽力而为语义：多 CLI 对计数文件读改写不加锁（票面未要求严格互斥，丢一次计数
 * 只影响开窗时机，不影响「永远能出声」的下限）；文件损坏/不可读写判「闭合」——
 * 熔断器误闸拦住正常热路径，比漏闸多放一次坏拉起更有害。
 *
 * 清零是原子写零记录（count 0 + freshAt 哨兵）而非删文件：record 写回前复读一次
 * 现文件，基线在两读之间被清零覆盖（或被外部删除）即放弃写回，否则按复读基线续计
 * ——「陈旧计数把已清零的冷却窗复活」的窗口从整个读改写期收窄为单次首读与复读的
 * 微秒间隙。残余窗内再丢一次清零的后果是冷却窗复活 ≤10min 走 per-call，出声下限不破。
 */

/** 计数文件名（与 shim 侧约定一致：与 sock/pid 同目录，引擎级一个文件） */
export const DAEMON_FAILURES_FILENAME = "daemon-failures";
/** 开窗阈值：窗内累计第 N 次失败即进冷却 */
export const CIRCUIT_FAILURE_THRESHOLD = 3;
/** 滑动窗：两次失败间隔超窗则计数重开（冷却耗尽后的孤立失败不该背历史） */
export const CIRCUIT_SLIDING_WINDOW_MS = 10 * 60_000;
/** 冷却时长：开窗后这么久内 ensure 直拒 daemon 路径 */
export const CIRCUIT_COOLDOWN_MS = 10 * 60_000;

export interface CircuitRecord {
  count: number;
  lastAt: number;
  /** 非 null = 已开窗时刻；冷却判据 = now - openedAt < CIRCUIT_COOLDOWN_MS */
  openedAt: number | null;
  /** 清零哨兵：clearCircuitFailures 的落盘时刻。在位 = 这份记录源自清零而非自然计数，
   *  后续写回按零基线续起；并发在途写回据此判别自己的基线是否已被清零覆盖 */
  freshAt?: number;
}

/** 时钟注入面：真机走 Date.now，测试推进假时钟免真等 */
export interface CircuitHandle {
  path: string;
  now(): number;
}

/** 读计数记录；任何不可读/形状非法都归 null（= 无劣化史） */
export function readCircuitRecord(path: string): CircuitRecord | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return null;
    const rec = raw as Record<string, unknown>;
    if (
      typeof rec.count !== "number" ||
      typeof rec.lastAt !== "number" ||
      !(rec.openedAt === null || typeof rec.openedAt === "number") ||
      !(rec.freshAt === undefined || typeof rec.freshAt === "number")
    ) {
      return null;
    }
    // exactOptionalPropertyTypes：哨兵缺席用无键形态表达，不写 undefined 键
    return rec.freshAt === undefined
      ? { count: rec.count, lastAt: rec.lastAt, openedAt: rec.openedAt }
      : { count: rec.count, lastAt: rec.lastAt, openedAt: rec.openedAt, freshAt: rec.freshAt };
  } catch {
    return null;
  }
}

/** 冷却闸是否落下：到期自动放行（下一次 ensure 给 daemon 形态重试机会） */
export function isCircuitOpen(handle: CircuitHandle): boolean {
  const rec = readCircuitRecord(handle.path);
  if (rec === null || rec.openedAt === null) return false;
  return handle.now() - rec.openedAt < CIRCUIT_COOLDOWN_MS;
}

/**
 * 记一次 daemon 形态失败。写路径不依赖读成功：坏文件直接被覆盖成合法记录（自愈）。
 * 落盘走 tmp+rename：并发 CLI 各写各的，读者永远只会看到整份旧记录或整份新记录。
 * 时钟取用序 at → 首读 → tmp 名 → 复读 → 写回是刻意排布：复读必须发生在 tmp 名取时
 * 之后，测试才能把并发清零挂在第二次取时的副作用上进而确定性构造交错。
 */
export function recordCircuitFailure(handle: CircuitHandle): void {
  const at = handle.now();
  const prev = readCircuitRecord(handle.path);
  // tmp 名带 pid 分区（与 speak/engines-command 的原子写惯例同形）：跨进程同毫秒
  // 各写各的临时名，不会出现「A 的 rename 消耗了 B 刚写入的同名 tmp、B 的 rename
  // ENOENT 被静默吞掉」这种把另一方的写整个丢掉的碰撞形态
  const tmp = `${handle.path}.${handle.now()}.${process.pid}.tmp`;
  const recheck = readCircuitRecord(handle.path);
  if (recheck === null) {
    // 基线在两读之间被清零或被外部删除：写回等于从陈旧计数复活，放弃（首读本就无记录则正常续写）
    if (prev !== null) return;
  } else if (recheck.freshAt !== undefined && recheck.freshAt >= at) {
    // 清零落点不早于本次失败时刻：本次失败已被清零覆盖，放弃写回（同毫秒按清零获胜收口）
    return;
  }
  const base = recheck;
  const inWindow = base !== null && at - base.lastAt <= CIRCUIT_SLIDING_WINDOW_MS;
  const count = inWindow ? base.count + 1 : 1;
  // 已开窗后再失败刷新 openedAt：在途崩溃类失败发生在冷却起点之后，坏 daemon 不该被连环重试
  const openedAt = count >= CIRCUIT_FAILURE_THRESHOLD ? at : base !== null && inWindow ? base.openedAt : null;
  const record: CircuitRecord =
    base?.freshAt === undefined
      ? { count, lastAt: at, openedAt }
      : { count, lastAt: at, openedAt, freshAt: base.freshAt };
  try {
    mkdirSync(dirname(handle.path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(record));
    renameSync(tmp, handle.path);
  } catch {
    // lab 目录不可写/竞态 rename 失败：熔断是尽力而为的优化面，绝不炸出声主链路
  }
}

/**
 * 温态合成成功调用：劣化史一笔勾销。原子写零记录而非 unlink——「被清零」与「从未有记录」
 * 在文件面可分辨，并发在途写回不会拿旧计数把冷却窗复活；判据面等价（openedAt null = 闭合）。
 */
export function clearCircuitFailures(handle: CircuitHandle): void {
  const at = handle.now();
  const record: CircuitRecord = { count: 0, lastAt: at, openedAt: null, freshAt: at };
  try {
    mkdirSync(dirname(handle.path), { recursive: true });
    const tmp = `${handle.path}.${at}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(record));
    renameSync(tmp, handle.path);
  } catch {
    // lab 目录不可写/竞态 rename 失败：与 record 同为尽力而为，绝不炸出声主链路
  }
}
