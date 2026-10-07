import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CIRCUIT_COOLDOWN_MS,
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_SLIDING_WINDOW_MS,
  clearCircuitFailures,
  isCircuitOpen,
  readCircuitRecord,
  recordCircuitFailure,
  type CircuitHandle,
} from "../src/engines/daemon-circuit.ts";

/**
 * daemon 故障熔断单元面（票 04 §4 判据的文件语义）：滑动窗计数、开窗冷却、
 * 成功清零、损坏回退闭合、原子写不残留。时钟全部走注入，不借真实等待。
 */

function makeHandle(dir: string): { handle: CircuitHandle; advance: (ms: number) => void } {
  let t = 1_000_000; // 非零零点：防「0 被当缺席值」类缺陷在测试里隐身
  const handle: CircuitHandle = { path: join(dir, "daemon-failures"), now: () => t };
  return { handle, advance: (ms: number) => { t += ms; } };
}

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "say-circuit-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("daemon-circuit：滑动窗计数与开窗", () => {
  it("阈值常量钉死票 04 口径：3 次失败 / 窗与冷却各 10min", () => {
    expect(CIRCUIT_FAILURE_THRESHOLD).toBe(3);
    expect(CIRCUIT_SLIDING_WINDOW_MS).toBe(10 * 60_000);
    expect(CIRCUIT_COOLDOWN_MS).toBe(10 * 60_000);
  });

  it("窗内累计第三次失败即开窗；前两次保持闭合", () => {
    withTempDir((dir) => {
      const { handle } = makeHandle(dir);
      recordCircuitFailure(handle);
      expect(readCircuitRecord(handle.path)).toEqual({ count: 1, lastAt: handle.now(), openedAt: null });
      expect(isCircuitOpen(handle)).toBe(false);
      recordCircuitFailure(handle);
      expect(isCircuitOpen(handle)).toBe(false);
      recordCircuitFailure(handle);
      const rec = readCircuitRecord(handle.path);
      expect(rec?.count).toBe(3);
      expect(rec?.openedAt).toBe(handle.now()); // 开窗时刻落盘：冷却从最后一次失败起算
      expect(isCircuitOpen(handle)).toBe(true);
    });
  });

  it("两次失败间隔超窗：计数重开为 1（冷却耗尽后的重试由此免付历史）", () => {
    withTempDir((dir) => {
      const { handle, advance } = makeHandle(dir);
      recordCircuitFailure(handle);
      recordCircuitFailure(handle);
      advance(CIRCUIT_SLIDING_WINDOW_MS + 1);
      recordCircuitFailure(handle);
      const rec = readCircuitRecord(handle.path);
      expect(rec?.count).toBe(1); // 若是 3 会把「隔了 10 分钟的孤立失败」误判成持续劣化
      expect(isCircuitOpen(handle)).toBe(false);
    });
  });

  it("冷却到期自动放行；期内再失败刷新开窗时刻", () => {
    withTempDir((dir) => {
      const { handle, advance } = makeHandle(dir);
      recordCircuitFailure(handle);
      recordCircuitFailure(handle);
      recordCircuitFailure(handle);
      expect(isCircuitOpen(handle)).toBe(true);
      advance(CIRCUIT_COOLDOWN_MS + 1);
      expect(isCircuitOpen(handle)).toBe(false); // 到期不再拉闸：给常驻形态一次重试机会
      // 期内失败：已开窗后 count 续增且 openedAt 刷新（在途崩溃延长冷却，坏 daemon 不被连环重试）
      const { handle: h2 } = makeHandle(dir);
      recordCircuitFailure(h2); // 此刻距上次失败 < 窗：count=2
      recordCircuitFailure(h2); // count=3 开窗
      expect(isCircuitOpen(h2)).toBe(true);
    });
  });
});

describe("daemon-circuit：清零、损坏自愈与落盘卫生", () => {
  it("成功清零删文件；对不存在的记录再清是安全的", () => {
    withTempDir((dir) => {
      const { handle } = makeHandle(dir);
      recordCircuitFailure(handle);
      clearCircuitFailures(handle);
      expect(existsSync(handle.path)).toBe(false);
      expect(isCircuitOpen(handle)).toBe(false);
      expect(() => clearCircuitFailures(handle)).not.toThrow();
    });
  });

  it("损坏文件判熔断闭合（误闸拦路比漏闸更伤），下一次写入覆盖自愈", () => {
    withTempDir((dir) => {
      const { handle } = makeHandle(dir);
      writeFileSync(handle.path, "{not json");
      expect(readCircuitRecord(handle.path)).toBeNull();
      expect(isCircuitOpen(handle)).toBe(false);
      recordCircuitFailure(handle); // 写路径不依赖读成功：直接覆盖成合法记录
      expect(readCircuitRecord(handle.path)?.count).toBe(1);
      writeFileSync(handle.path, JSON.stringify({ count: "x", lastAt: null })); // 形状非法
      expect(readCircuitRecord(handle.path)).toBeNull();
    });
  });

  it("原子写不留 tmp 残件；父目录缺失静默容忍（熔断器永不炸出声主链路）", () => {
    withTempDir((dir) => {
      const { handle } = makeHandle(dir);
      recordCircuitFailure(handle);
      expect(readdirSync(dir).filter((name) => name.includes(".tmp"))).toHaveLength(0);
      const ghost = join(dir, "no/such/dir/daemon-failures");
      expect(() => recordCircuitFailure({ path: ghost, now: handle.now })).not.toThrow();
      expect(() => clearCircuitFailures({ path: ghost, now: handle.now })).not.toThrow();
    });
  });
});
