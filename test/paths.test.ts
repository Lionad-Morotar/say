import { describe, expect, it } from "vitest";
import { resolvePaths } from "../src/paths.ts";

describe("resolvePaths：XDG 布局且可注入", () => {
  it("无 XDG 变量时落 HOME 下的默认三目录", () => {
    expect(resolvePaths({ HOME: "/h" })).toEqual({
      configFile: "/h/.config/say/config.toml",
      modelsDir: "/h/.cache/say/models",
      voicesDir: "/h/.local/share/say/voices",
    });
  });

  it("XDG 三变量各自覆盖对应根，互不串位", () => {
    expect(
      resolvePaths({
        HOME: "/h",
        XDG_CONFIG_HOME: "/c",
        XDG_CACHE_HOME: "/k",
        XDG_DATA_HOME: "/d",
      }),
    ).toEqual({
      configFile: "/c/say/config.toml",
      modelsDir: "/k/say/models",
      voicesDir: "/d/say/voices",
    });
  });

  it("XDG 变量为空串视同未设，回落 HOME 默认", () => {
    expect(resolvePaths({ HOME: "/h", XDG_CONFIG_HOME: "" })).toMatchObject({
      configFile: "/h/.config/say/config.toml",
    });
  });

  it("HOME 尾斜杠不产生双斜杠路径", () => {
    expect(resolvePaths({ HOME: "/h/" }).modelsDir).toBe("/h/.cache/say/models");
  });
});
