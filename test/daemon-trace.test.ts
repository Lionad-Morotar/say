import { beforeEach, describe, expect, it } from "vitest";
import { daemonFormOf, recordDaemonForm, resetDaemonTrace } from "../src/daemon-trace.ts";

/**
 * daemon-trace 单例的覆盖序（热启动 S6）：SAY_DEBUG 摘要读的是「这次调用走没走热路」，
 * 形态事件在合成期多路并发到达（established / 降级 / 冷却），记账规则决定末次可见形态。
 */
describe("daemon-trace：形态记账覆盖序", () => {
  beforeEach(() => resetDaemonTrace());

  it("无记账引擎查得 null：渲染面据此省略 daemon 段", () => {
    expect(daemonFormOf("sherpa")).toBeNull();
  });

  it("warm/cold 终态：后续降级噪音不回改", () => {
    recordDaemonForm("gptsovits", "warm");
    recordDaemonForm("gptsovits", "per-call");
    expect(daemonFormOf("gptsovits")).toEqual({ form: "warm", coldMs: null });
    recordDaemonForm("indextts", "cold", 6350);
    recordDaemonForm("indextts", "cooldown");
    expect(daemonFormOf("indextts")).toEqual({ form: "cold", coldMs: 6350 });
  });

  it("cooldown 压在 per-call 之上：冷却直拒是因、退路出声是果，摘要展示因", () => {
    recordDaemonForm("firered", "cooldown");
    recordDaemonForm("firered", "per-call");
    expect(daemonFormOf("firered")).toEqual({ form: "cooldown", coldMs: null });
  });

  it("低信息量被高信息量升级：off 之后 warm 命中照常入账", () => {
    recordDaemonForm("voxcpm", "off");
    recordDaemonForm("voxcpm", "warm");
    expect(daemonFormOf("voxcpm")).toEqual({ form: "warm", coldMs: null });
  });

  it("coldMs 只随 cold 落账：其余形态恒 null，渲染 cold(Xs) 不歧义", () => {
    recordDaemonForm("gptsovits", "warm", 9999);
    expect(daemonFormOf("gptsovits")?.coldMs).toBeNull();
  });
});
