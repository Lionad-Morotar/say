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
      preset: null,
      engine: null,
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

  it.each(["-v", "-r", "-o", "-f", "--voice", "--rate", "--output-file", "--input-file", "--engine"])(
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

  it.each([[["--preset", "calm", "hi"]], [["--preset=calm", "hi"]]])(
    "--preset 是本工具的自研 flag，不走透传：%j",
    (argv) => {
      expect(parseArgv(argv)).toMatchObject({ kind: "speak", preset: "calm" });
    },
  );

  it.each([[["--engine", "gptsovits", "hi"]], [["--engine=gptsovits", "hi"]]])(
    "--engine 是本工具的自研 flag，不走透传：%j",
    (argv) => {
      expect(parseArgv(argv)).toMatchObject({ kind: "speak", engine: "gptsovits" });
    },
  );

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

describe("engine 管理子命令解析", () => {
  it("engine ls 是管理请求", () => {
    expect(parseArgv(["engine", "ls"])).toEqual({ kind: "engine", action: "ls", name: null });
  });

  it("engine use 带引擎名", () => {
    expect(parseArgv(["engine", "use", "gptsovits"])).toEqual({
      kind: "engine",
      action: "use",
      name: "gptsovits",
    });
  });

  it.each([[["engine"]], [["engine", "use"]], [["engine", "use", "--bogus"]]])(
    "engine 裸词与 use 缺名/名以 - 开头是用法错误：%j",
    (argv) => {
      expect(parseArgv(argv)).toMatchObject({ kind: "usage-error" });
    },
  );

  it.each([[["engine", "ls", "now"]], [["engine", "use", "sherpa", "please"]]])(
    "识别出管理动词但带多余参数吵闹报错，不静默吞词：%j",
    (argv) => {
      expect(parseArgv(argv)).toMatchObject({ kind: "usage-error" });
    },
  );

  it("engine 后跟其他词整句回落文本合成，shadow 兼容承诺不因管理面收窄", () => {
    expect(parseArgv(["engine", "is", "loud"])).toMatchObject({
      kind: "speak",
      texts: ["engine", "is", "loud"],
    });
    expect(parseArgv(["hello", "engine", "ls"])).toMatchObject({
      kind: "speak",
      texts: ["hello", "engine", "ls"],
    });
  });
});

describe("daemon 管理子命令解析（热启动 S6）", () => {
  it("daemon ls 是管理请求", () => {
    expect(parseArgv(["daemon", "ls"])).toEqual({ kind: "daemon", action: "ls" });
  });

  it("daemon 裸词是用法错误，指引含 ls 与 stop 两个子命令", () => {
    const request = parseArgv(["daemon"]);
    expect(request).toMatchObject({ kind: "usage-error" });
    if (request.kind === "usage-error") {
      expect(request.message).toContain("daemon ls");
      expect(request.message).toContain("daemon stop");
    }
  });

  it("识别出 daemon ls 但带多余参数吵闹报错，不静默吞词", () => {
    expect(parseArgv(["daemon", "ls", "now"])).toMatchObject({ kind: "usage-error" });
  });

  it("daemon stop 带引擎名是停机请求", () => {
    expect(parseArgv(["daemon", "stop", "indextts"])).toEqual({ kind: "daemon", action: "stop", target: "indextts" });
  });

  it("无参与 --all 同义全停（票 05 的 [engine|--all] 可选形态）", () => {
    expect(parseArgv(["daemon", "stop"])).toEqual({ kind: "daemon", action: "stop", target: "all" });
    expect(parseArgv(["daemon", "stop", "--all"])).toEqual({ kind: "daemon", action: "stop", target: "all" });
  });

  it("daemon stop 带多余参数吵闹报错；陌生引擎名放行给编排层校验（解析忠实映射）", () => {
    expect(parseArgv(["daemon", "stop", "gptsovits", "now"])).toMatchObject({ kind: "usage-error" });
    expect(parseArgv(["daemon", "stop", "sherpa"])).toEqual({ kind: "daemon", action: "stop", target: "sherpa" });
  });

  it("daemon 后跟其他词整句回落文本合成，与 engine 同一兼容纪律", () => {
    expect(parseArgv(["daemon", "is", "quiet"])).toMatchObject({
      kind: "speak",
      texts: ["daemon", "is", "quiet"],
    });
    expect(parseArgv(["the", "daemon", "ls"])).toMatchObject({
      kind: "speak",
      texts: ["the", "daemon", "ls"],
    });
  });
});
