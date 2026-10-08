import { beforeEach, describe, expect, it } from "vitest";
import { EXIT_OK, writeDebug } from "../src/report.ts";
import { recordDaemonForm, resetDaemonTrace } from "../src/daemon-trace.ts";
import type { ResolvedConfig } from "../src/types.ts";
import { createFakeHost } from "./fake-host.ts";

/**
 * SAY_DEBUG daemon 段的渲染口径（蓝图词表）：warm|cold(Xs)|per-call|cooldown|off
 * 拼进摘要行 engine= 之后；非 daemon 引擎无记账则整段省略。
 */

const config: ResolvedConfig = { engine: "gptsovits", voice: null, rateWpm: 175, fallback: "system", debug: true };

function debugLine(engineName: string): string {
  const fake = createFakeHost({ env: { HOME: "/h" } });
  writeDebug(fake.host, config, { code: EXIT_OK, engineName }, "frieren", 2, { started: 0, synth: 1200, play: 800 });
  return fake.stderr.join("");
}

describe("writeDebug：SAY_DEBUG daemon 段渲染", () => {
  beforeEach(() => resetDaemonTrace());

  it("warm：daemon=warm 紧随 engine 段，无耗时尾巴", () => {
    recordDaemonForm("gptsovits", "warm");
    const line = debugLine("gptsovits");
    expect(line).toContain("engine=gptsovits daemon=warm voice=frieren");
  });

  it("cold：携本调用实付加载窗 cold(Xs)，一位小数", () => {
    recordDaemonForm("indextts", "cold", 6350);
    const line = debugLine("indextts");
    expect(line).toContain("daemon=cold(6.4s)");
  });

  it("cold 不足一秒也保一位小数刻度，不退化成整数", () => {
    recordDaemonForm("gptsovits", "cold", 820);
    expect(debugLine("gptsovits")).toContain("daemon=cold(0.8s)");
  });

  it("per-call / cooldown / off 三形态按词表原样渲染", () => {
    resetDaemonTrace();
    recordDaemonForm("firered", "cooldown");
    expect(debugLine("firered")).toContain("daemon=cooldown");
    resetDaemonTrace();
    recordDaemonForm("firered", "per-call");
    expect(debugLine("firered")).toContain("daemon=per-call");
    resetDaemonTrace();
    recordDaemonForm("voxcpm", "off");
    expect(debugLine("voxcpm")).toContain("daemon=off");
  });

  it("非 daemon 引擎（sherpa/system）无记账：整段省略，grep daemon= 不误伤", () => {
    const line = debugLine("sherpa");
    expect(line).not.toContain("daemon=");
    expect(line).toContain("engine=sherpa voice=");
  });
});

/** 覆盖序与终态语义的记账面单测见 daemon-trace.test.ts，本文件只管渲染 */
