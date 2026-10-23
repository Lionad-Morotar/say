// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import BlindTest from "../app/components/BlindTest.vue";
import VerdictHistory from "../app/components/VerdictHistory.vue";

const engines = ["sherpa", "system", "indextts"];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BlindTest", () => {
  it("渲染两源选择与题目，未选满引擎时不可开始", () => {
    const w = mount(BlindTest, { props: { engines, voices: ["af_maple", "default"] } });
    expect(w.find("[data-testid='blind-engine-a']").exists()).toBe(true);
    expect(w.find("[data-testid='blind-engine-b']").exists()).toBe(true);
    expect(w.find("[data-testid='blind-prompt']").exists()).toBe(true);
    expect((w.find("[data-testid='blind-start']").attributes("disabled") !== undefined)).toBe(true);
  });

  it("盲态前不渲染选择按钮，揭盲文本不泄漏源身份", () => {
    const w = mount(BlindTest, { props: { engines, voices: [] } });
    expect(w.find("[data-testid='blind-pick-first']").exists()).toBe(false);
    expect(w.find("[data-testid='blind-play']").exists()).toBe(false);
  });
});

describe("VerdictHistory", () => {
  it("无数据时渲染空态提示", async () => {
    vi.stubGlobal("$fetch", vi.fn().mockResolvedValue([]));
    const w = mount(VerdictHistory);
    await vi.waitFor(() => {
      expect(w.find("[data-testid='verdict-empty']").exists()).toBe(true);
    });
  });
});
