import { describe, expect, it } from "vitest";
import { BUILTIN_PRESETS, parseConfigFile, resolveConfig } from "../src/config.ts";

// 零配置参照值：voice/引擎双缺席整套落 locale 缺省 en 的预设（试听裁决三语默认）
const DEFAULTS = {
  engine: "firered",
  voice: "default",
  rateWpm: 175,
  fallback: "system",
  debug: false,
} as const;

describe("parseConfigFile：预设分节与选择键", () => {
  it("preset 选择键与 presets 表按原样读出，类型校验留给 resolveConfig", () => {
    const text = ['preset = "calm"', "[presets.calm]", 'voice = "bf_vale"', "speed = 160", 'engine = "sherpa"'].join("\n");
    expect(parseConfigFile(text)).toEqual({
      ok: true,
      value: { preset: "calm", presets: { calm: { voice: "bf_vale", speed: 160, engine: "sherpa" } } },
    });
  });

  it("无预设分节时不产出 presets 键", () => {
    expect(parseConfigFile('engine = "system"\n')).toEqual({ ok: true, value: { engine: "system" } });
  });
});

describe("内置通用嗓预设", () => {
  it("en 走 firered 内置示例参考嗓，zh 走 indextts + 中文角色嗓（261007 试听裁决三语默认）", () => {
    expect(BUILTIN_PRESETS.en).toEqual({ voice: "default", engine: "firered" });
    expect(BUILTIN_PRESETS.zh).toEqual({ voice: "frieren-zh", engine: "indextts" });
    expect(BUILTIN_PRESETS.ja).toEqual({ voice: "frieren", engine: "gptsovits" });
  });
});

describe("resolveConfig 预设机制", () => {
  const PRESETS = {
    presets: {
      calm: { voice: "bf_vale", speed: 160, engine: "sherpa" },
      system: { engine: "system" },
    },
  };

  it("config preset 选择键激活预设，未显式指定的维度由预设填充", () => {
    const { config, warnings } = resolveConfig({ env: {}, file: { ...PRESETS, preset: "calm" }, flags: {} });
    expect(config).toMatchObject({ engine: "sherpa", voice: "bf_vale", rateWpm: 160 });
    expect(warnings).toHaveLength(0);
  });

  it("预设只填充未被更高层指定的维度：flag/env/config 各自胜出", () => {
    const { config } = resolveConfig({
      env: { SAY_VOICE: "af_sol", SAY_SPEED: "220" },
      file: { ...PRESETS, preset: "calm", voice: "af_maple" },
      flags: { rateWpm: 90 },
    });
    expect(config).toMatchObject({ voice: "af_sol", rateWpm: 90 });
  });

  it("预设选择优先级 --preset > SAY_PRESET > config preset", () => {
    const { config: byFlag } = resolveConfig({
      env: { SAY_PRESET: "system" },
      file: { ...PRESETS, preset: "calm" },
      flags: { preset: "calm" },
    });
    expect(byFlag).toMatchObject({ engine: "sherpa", voice: "bf_vale", rateWpm: 160 });

    const { config: byEnv } = resolveConfig({
      env: { SAY_PRESET: "system" },
      file: { ...PRESETS, preset: "calm" },
      flags: {},
    });
    expect(byEnv).toMatchObject({ engine: "system" });

    const { config: byFile } = resolveConfig({ env: {}, file: { ...PRESETS, preset: "calm" }, flags: {} });
    expect(byFile).toMatchObject({ engine: "sherpa" });
  });

  it("config 预设覆盖同名内置预设", () => {
    const { config } = resolveConfig({ env: {}, file: { presets: { zh: { voice: "zf_001" } }, preset: "zh" }, flags: {} });
    expect(config.voice).toBe("zf_001");
  });

  it("内置通用预设零配置即可用：--preset en / SAY_PRESET=zh 直接生效", () => {
    const { config: en } = resolveConfig({ env: { SAY_PRESET: "en" }, file: null, flags: {} });
    expect(en).toMatchObject({ engine: "firered", voice: "default" });
    const { config: zh } = resolveConfig({ env: {}, file: null, flags: { preset: "zh" } });
    expect(zh).toMatchObject({ engine: "indextts", voice: "frieren-zh" });
  });

  it("未登记的预设名降级并警告，警告点名可用清单", () => {
    const { config, warnings } = resolveConfig({ env: { SAY_PRESET: "nope" }, file: null, flags: {} });
    expect(config).toMatchObject(DEFAULTS);
    expect(warnings.join("\n")).toContain("nope");
    expect(warnings.join("\n")).toContain("en");
  });

  it("预设表坏条目降级并警告，不拖垮其余预设", () => {
    const { config, warnings } = resolveConfig({
      env: {},
      file: { presets: { bad: "not-a-table", calm: { voice: 3 } }, preset: "calm" },
      flags: {},
    });
    expect(config).toMatchObject(DEFAULTS);
    expect(warnings.join("\n")).toContain("bad");
  });

  it("presets 顶层是数组时整体降级警告，不产出按索引命名的幻影预设", () => {
    const { config, warnings } = resolveConfig({
      env: {},
      file: { presets: [{ voice: "x" }] },
      flags: {},
    });
    expect(config).toMatchObject(DEFAULTS);
    expect(warnings.join("\n")).toContain("期望分节表");
  });

  it("预设的坏字段值经同一宽容通道降级，其余字段仍生效", () => {
    const { config, warnings } = resolveConfig({
      env: {},
      file: { presets: { odd: { voice: 3, speed: 160 } }, preset: "odd" },
      flags: {},
    });
    expect(config).toMatchObject({ rateWpm: 160 });
    expect(warnings.join("\n")).toContain("odd");
  });

  it("没有选中预设时行为与无预设完全一致", () => {
    const { config, warnings } = resolveConfig({ env: {}, file: { ...PRESETS }, flags: {} });
    expect(config).toMatchObject(DEFAULTS);
    expect(warnings).toHaveLength(0);
  });
});