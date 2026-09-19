import { describe, expect, it } from "vitest";
import { parseArgv } from "../src/cli.ts";

describe("parseArgv：say 兼容调用面", () => {
  it("多位置参数按空格拼接的原料形态保留为数组", () => {
    expect(parseArgv(["hello", "world"])).toEqual({
      kind: "speak",
      texts: ["hello", "world"],
      inputFile: null,
      voice: null,
      rateWpm: null,
      output: null,
    });
  });

  it("零参数是可解析态而非用法错误，是否读 stdin 由上层裁决", () => {
    const req = parseArgv([]);
    expect(req).toMatchObject({ kind: "speak", texts: [], inputFile: null });
  });

  it("-f - 表示读 stdin", () => {
    expect(parseArgv(["-f", "-"])).toMatchObject({ kind: "speak", inputFile: "-" });
  });

  it("-f 指向真实文件时如实上报，与位置参数的优先级不在解析层裁决", () => {
    expect(parseArgv(["-f", "notes.txt", "extra"])).toMatchObject({
      kind: "speak",
      texts: ["extra"],
      inputFile: "notes.txt",
    });
  });

  it("--input-file= 长格式与 -f 等价", () => {
    expect(parseArgv(["--input-file=n.txt"])).toMatchObject({ kind: "speak", inputFile: "n.txt" });
  });

  it.each([
    [["-v", "af_sol", "hi"], "af_sol"],
    [["--voice", "af_sol", "hi"], "af_sol"],
    [["--voice=af_sol", "hi"], "af_sol"],
  ])("音色 flag 三种写法同义：%j", (argv, voice) => {
    expect(parseArgv(argv as string[])).toMatchObject({ kind: "speak", voice });
  });

  it.each([
    [["-r", "200", "hi"], 200],
    [["--rate=87.5", "hi"], 87.5],
  ])("语速 flag 解析为 wpm 数值：%j", (argv, rateWpm) => {
    expect(parseArgv(argv as string[])).toMatchObject({ kind: "speak", rateWpm });
  });

  it("-o 目标路径原样上报", () => {
    expect(parseArgv(["-o", "out.wav", "hi"])).toMatchObject({ kind: "speak", output: "out.wav" });
    expect(parseArgv(["--output-file=out.wav", "hi"])).toMatchObject({ kind: "speak", output: "out.wav" });
  });

  it("-- 之后的负号开头 token 是文本而非 flag", () => {
    expect(parseArgv(["--", "-1", "degrees"])).toMatchObject({
      kind: "speak",
      texts: ["-1", "degrees"],
    });
  });

  it.each(["-v", "-r", "-o", "-f", "--voice", "--rate", "--output-file", "--input-file"])(
    "受支持 flag 缺值是用法错误：%s",
    (flag) => {
      expect(parseArgv([flag])).toMatchObject({ kind: "usage-error" });
    },
  );

  it.each([[["-r", "abc"]], [["--rate=xyz"]], [["-r", ""]], [["-r", "-5"]]])(
    "语速非法是用法错误：%j",
    (argv) => {
      expect(parseArgv(argv)).toMatchObject({ kind: "usage-error" });
    },
  );

  it.each([
    ["--progress", "-o", "x.aiff", "passthrough"],
    ["-a", "1", "hi"],
    ["-n", "AUNetSend:9000", "hi"],
    ["-i", "hi"],
    ["--interactive", "hi"],
    ["--data-format=LEI16", "hi"],
  ])("未支持 flag 整条原样透传：%j", (...argv) => {
    expect(parseArgv(argv as string[])).toEqual({ kind: "passthrough", argv });
  });

  it("透传判定优先于受支持 flag 的解析错误", () => {
    expect(parseArgv(["--progress", "-v"])).toEqual({
      kind: "passthrough",
      argv: ["--progress", "-v"],
    });
  });

  it.each([[["-v", "?"]], [["--voice=?"]], [["-v", "?", "-o", "x.aiff"]], [["-o", "x.wav", "-v", "?"]]])(
    "音色值为 ? 是 macOS say 的列表模式，整条透传：%j",
    (argv) => {
      expect(parseArgv(argv)).toEqual({ kind: "passthrough", argv });
    },
  );

  it("音色值只是以 ? 开头或结尾时仍按普通音色名处理", () => {
    expect(parseArgv(["-v", "?af_maple", "hi"])).toMatchObject({ kind: "speak", voice: "?af_maple" });
    expect(parseArgv(["-v", "af_maple?", "hi"])).toMatchObject({ kind: "speak", voice: "af_maple?" });
  });
});
