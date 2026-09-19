import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE, DEFAULT_RATE_WPM, parseConfigFile, resolveConfig } from "../src/config.ts";

const DEFAULTS = {
  engine: DEFAULT_ENGINE,
  voice: null,
  rateWpm: DEFAULT_RATE_WPM,
  fallback: "system",
  debug: false,
} as const;

describe("parseConfigFile：TOML 子集宽容解析", () => {
  it("四个已知键按类型读出", () => {
    const text = 'engine = "system"\nvoice = "af_sol"\nspeed = 200\nfallback = "off"\n';
    expect(parseConfigFile(text)).toEqual({
      ok: true,
      value: { engine: "system", voice: "af_sol", speed: 200, fallback: "off" },
    });
  });

  it("注释、空行与未知键不影响已知键读出，presets 分节按原样读出", () => {
    const text = [
      "# 全局配置",
      "",
      'engine = "sherpa"   # 行尾注释',
      "unknown = 1",
      "[presets.calm]",
      'voice = "bf_vale"',
    ].join("\n");
    expect(parseConfigFile(text)).toEqual({
      ok: true,
      value: { engine: "sherpa", presets: { calm: { voice: "bf_vale" } } },
    });
  });

  it("语法损坏返回 error 而非抛错，调用方据此降级", () => {
    expect(parseConfigFile('engine = "sherpa')).toMatchObject({ ok: false });
  });
});

describe("resolveConfig：flag > env > config > 默认", () => {
  it("三层全空即零配置默认值，首次运行可出声", () => {
    expect(resolveConfig({ env: {}, file: null, flags: {} }).config).toEqual(DEFAULTS);
  });

  it("默认语速锚定 macOS say 实测默认 175 wpm", () => {
    expect(DEFAULT_RATE_WPM).toBe(175);
  });

  it("config 覆盖默认", () => {
    const { config } = resolveConfig({
      env: {},
      file: { engine: "system", voice: "baker", speed: 200, fallback: "off" },
      flags: {},
    });
    expect(config).toEqual({ ...DEFAULTS, engine: "system", voice: "baker", rateWpm: 200, fallback: "off" });
  });

  it("env 覆盖 config", () => {
    const { config } = resolveConfig({
      env: { SAY_ENGINE: "system", SAY_VOICE: "af_sol", SAY_SPEED: "220" },
      file: { engine: "sherpa", voice: "af_maple", speed: 200 },
      flags: {},
    });
    expect(config).toMatchObject({ engine: "system", voice: "af_sol", rateWpm: 220 });
  });

  it("flag 覆盖 env", () => {
    const { config } = resolveConfig({
      env: { SAY_VOICE: "af_sol", SAY_SPEED: "220" },
      file: { voice: "af_maple" },
      flags: { voice: "bf_vale", rateWpm: 90 },
    });
    expect(config).toMatchObject({ voice: "bf_vale", rateWpm: 90 });
  });

  it("flag 只覆盖自己出现过的维度，未给的维度仍由 env/config 决定", () => {
    const { config } = resolveConfig({
      env: { SAY_ENGINE: "system", SAY_VOICE: "af_sol" },
      file: null,
      flags: { rateWpm: 90 },
    });
    expect(config).toMatchObject({ engine: "system", voice: "af_sol", rateWpm: 90 });
  });

  it("SAY_DEBUG=1 打开调试摘要，其余值不开", () => {
    expect(resolveConfig({ env: { SAY_DEBUG: "1" }, file: null, flags: {} }).config.debug).toBe(true);
    expect(resolveConfig({ env: { SAY_DEBUG: "0" }, file: null, flags: {} }).config.debug).toBe(false);
  });

  describe("环境层宽容：坏值降级为默认并给出警告，不让 say 整体不可用", () => {
    it("SAY_SPEED 非数值", () => {
      const { config, warnings } = resolveConfig({ env: { SAY_SPEED: "fast" }, file: null, flags: {} });
      expect(config.rateWpm).toBe(DEFAULT_RATE_WPM);
      expect(warnings.join("\n")).toContain("SAY_SPEED");
    });

    it("SAY_SPEED 非正数", () => {
      const { config, warnings } = resolveConfig({ env: { SAY_SPEED: "0" }, file: null, flags: {} });
      expect(config.rateWpm).toBe(DEFAULT_RATE_WPM);
      expect(warnings).toHaveLength(1);
    });

    it("config 的 fallback 非法值", () => {
      const { config, warnings } = resolveConfig({ env: {}, file: { fallback: "nope" }, flags: {} });
      expect(config.fallback).toBe("system");
      expect(warnings.join("\n")).toContain("fallback");
    });

    it("数值字符串按数值收下：env 天然是字符串，config 写成字符串是同一个意思", () => {
      const { config, warnings } = resolveConfig({ env: {}, file: { speed: "200" }, flags: {} });
      expect(config.rateWpm).toBe(200);
      expect(warnings).toHaveLength(0);
    });

    it("config 的 speed 不可解析为数值", () => {
      const { config, warnings } = resolveConfig({ env: {}, file: { speed: "200wpm" }, flags: {} });
      expect(config.rateWpm).toBe(DEFAULT_RATE_WPM);
      expect(warnings).toHaveLength(1);
    });

    it("engine 名未登记不在此层报错，留给引擎选择环节走回退", () => {
      const { config, warnings } = resolveConfig({ env: { SAY_ENGINE: "nonexistent" }, file: null, flags: {} });
      expect(config.engine).toBe("nonexistent");
      expect(warnings).toHaveLength(0);
    });
  });
});
