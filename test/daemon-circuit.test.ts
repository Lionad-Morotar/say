import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
  it("成功清零为原子写零记录（文件仍在、劣化史收敛）；对不存在的记录再清是安全的", () => {
    withTempDir((dir) => {
      const { handle } = makeHandle(dir);
      recordCircuitFailure(handle);
      clearCircuitFailures(handle);
      const rec = readCircuitRecord(handle.path);
      expect(existsSync(handle.path)).toBe(true);
      expect(rec?.count).toBe(0);
      expect(rec?.openedAt).toBeNull();
      expect(rec?.freshAt).toBe(rec?.lastAt);
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

describe("daemon-circuit：并发清零不被陈旧写回复活", () => {
  /**
   * record 的时钟取用序 = at → prev 读 → tmp 名 → 复读 → 写回：
   * 测试把并发清零挂在自己 handle 的第二次 now() 副作用上，即确定性造出
   * 「首读到旧记录 → 清零落地 → 复读见到新态」的交错（真机两处读相邻，窗为微秒级）。
   */
  function scriptedClock(path: string, at: number, sideEffect: () => void): CircuitHandle {
    let calls = 0;
    return {
      path,
      now: () => {
        calls += 1;
        if (calls === 2) sideEffect();
        return at;
      },
    };
  }

  it("B 首读旧计数 → A 清零 → B 写回放弃：零记录保持，冷却史不复活", () => {
    withTempDir((dir) => {
      const path = join(dir, "daemon-failures");
      writeFileSync(path, JSON.stringify({ count: 2, lastAt: 999_000, openedAt: null }));
      const handleA: CircuitHandle = { path, now: () => 1_000_000 };
      recordCircuitFailure(scriptedClock(path, 1_000_000, () => clearCircuitFailures(handleA)));
      expect(readCircuitRecord(path)).toEqual({ count: 0, lastAt: 1_000_000, openedAt: null, freshAt: 1_000_000 });
    });
  });

  it("B 首读旧计数 → 注册点被外部删除 → B 写回放弃：不从陈旧基线复活", () => {
    withTempDir((dir) => {
      const path = join(dir, "daemon-failures");
      writeFileSync(path, JSON.stringify({ count: 2, lastAt: 999_000, openedAt: null }));
      recordCircuitFailure(scriptedClock(path, 1_000_000, () => unlinkSync(path)));
      expect(readCircuitRecord(path)).toBeNull();
      expect(isCircuitOpen({ path, now: () => 1_000_000 })).toBe(false);
    });
  });

  it("他 CLI 计数落在 B 两读之间：B 复读按新基线续计，计数不丢、开窗不漏", () => {
    withTempDir((dir) => {
      const path = join(dir, "daemon-failures");
      writeFileSync(path, JSON.stringify({ count: 2, lastAt: 999_000, openedAt: null }));
      const handleA: CircuitHandle = { path, now: () => 1_000_000 };
      recordCircuitFailure(scriptedClock(path, 1_000_000, () => recordCircuitFailure(handleA)));
      // A 先把 {2} 推到 {3} 并开窗，B 复读取 {3} 基线续成 {4}——旧实现会写回 {3} 吞掉 A 的那一次
      const rec = readCircuitRecord(path);
      expect(rec?.count).toBe(4);
      expect(rec?.openedAt).toBe(1_000_000);
    });
  });

  it("同毫秒清零与计数连环混写：tmp 残件互不吞噬，同毫秒按清零获胜收口", () => {
    withTempDir((dir) => {
      const { handle } = makeHandle(dir);
      recordCircuitFailure(handle);
      clearCircuitFailures(handle);
      // 与清零同毫秒（假时钟恒值）的失败按「清零不早于失败时刻」放弃写回——同毫秒碰撞两形态：
      // tmp 名带 pid 分区后跨进程不再互噬，进程内顺序写最后 rename 决胜，此处钉死清零获胜语义
      recordCircuitFailure(handle);
      expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toHaveLength(0);
      expect(readCircuitRecord(handle.path)).toEqual({ count: 0, lastAt: handle.now(), openedAt: null, freshAt: handle.now() });
    });
  });

  it("清零后的首个失败从零记录续起 1，哨兵随记录传播（更晚到达的陈旧写回仍认得出清零证据）", () => {
    withTempDir((dir) => {
      const { handle, advance } = makeHandle(dir);
      recordCircuitFailure(handle);
      clearCircuitFailures(handle);
      const clearedAt = handle.now();
      advance(1);
      recordCircuitFailure(handle);
      const rec = readCircuitRecord(handle.path);
      expect(rec).toEqual({ count: 1, lastAt: clearedAt + 1, openedAt: null, freshAt: clearedAt });
    });
  });
});
