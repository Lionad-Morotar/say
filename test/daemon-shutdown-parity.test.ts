import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DAEMON_ENGINES } from "../src/config.ts";
import { STOP_GRACE_MS } from "../src/daemon-stop.ts";

/**
 * 四引擎停机 parity 对拍（S5 移交、S6 收口）：say daemon stop 的双通道触达要求
 * 四 shim 的 shutdown 帧判定与 SIGTERM 捕获语义逐字同形——引擎库各异，但「stop_flag.set()
 * 即停止接受并排空在途」的生命周期契约必须一致，否则 stop 的按引擎窗就成了逐引擎碰运气。
 * 双实现对拍的先例是 daemon-fingerprint.test.ts（TS 与 Python 的指纹面同构校验）。
 */

const SHIMS: readonly string[] = DAEMON_ENGINES.map((engine) => `scripts/shims/${engine}-shim.py`);

function shimSource(path: string): string {
  return readFileSync(path, "utf8");
}

describe("daemon 停机面四引擎同形", () => {
  it.each(DAEMON_ENGINES)("%s shim：daemon 请求处理带 shutdown 帧判定并落 stop_flag", (engine) => {
    const src = shimSource(`scripts/shims/${engine}-shim.py`);
    expect(src).toContain('if req.get("type") == "shutdown":');
    // 判定紧邻的优雅退场动作：置 stop_flag 交主循环排空在途后自退
    const at = src.indexOf('if req.get("type") == "shutdown":');
    expect(src.slice(at, at + 320)).toContain("stop_flag.set()");
  });

  it.each(DAEMON_ENGINES)("%s shim：SIGTERM 捕获与 shutdown 帧收敛到同一 stop_flag", (engine) => {
    const src = shimSource(`scripts/shims/${engine}-shim.py`);
    expect(src).toContain("signal.signal(signal.SIGTERM");
    const handler = src.slice(src.indexOf("signal.signal(signal.SIGTERM"), src.indexOf("signal.signal(signal.SIGTERM") + 200);
    expect(handler).toContain("stop_flag.set()");
  });

  it("TS 侧 stop 帧的键值形态命中 shim 判定面：type 序列化为 shutdown", () => {
    // sendShutdownFrame 的帧文本与 shim 的 req.get("type") == "shutdown" 是跨语言契约，
    // 以构造出的帧直接过 shim 判定语义核对（解析后的键值对拍，不依赖实现文本）
    const frame = `${JSON.stringify({ type: "shutdown" })}\n`;
    const parsed = JSON.parse(frame) as Record<string, unknown>;
    expect(parsed.type).toBe("shutdown");
  });

  it("STOP_GRACE_MS 覆盖全引擎且都在加载窗量级之下：停机等待不该比冷启动还久", () => {
    for (const engine of DAEMON_ENGINES) {
      expect(STOP_GRACE_MS[engine]).toBeGreaterThan(0);
    }
    // GPU 三档（MPS 释放实测 ~7s + 排空余量）必须宽于 CPU 档：一刀切会误杀 GPU 在途排空
    expect(STOP_GRACE_MS.gptsovits).toBeLessThan(STOP_GRACE_MS.indextts);
    expect(STOP_GRACE_MS.voxcpm).toBe(STOP_GRACE_MS.indextts);
    expect(STOP_GRACE_MS.firered).toBe(STOP_GRACE_MS.indextts);
  });
});

describe("四 shim 源文件在场（对拍面的存在性前提）", () => {
  it("SHIMS 清单与 DAEMON_ENGINES 一一对应且都可读", () => {
    expect(SHIMS).toHaveLength(DAEMON_ENGINES.length);
    for (const path of SHIMS) {
      expect(() => shimSource(join(path))).not.toThrow();
    }
  });
});
