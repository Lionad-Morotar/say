import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseDebugLine,
  sayArgs,
  synthesize,
  SayError,
  type SayRunner,
} from "../server/lib/say-bridge.ts";

const RIFF = Buffer.from("RIFF....WAVE");

/** 独立期望源：261022 真实合成实测的两种 debug 行形态（sherpa in-process 与 indextts daemon=warm） */
describe("parseDebugLine", () => {
  it("解析无 daemon 段形态", () => {
    expect(
      parseDebugLine("say: debug: engine=sherpa voice=af_maple chunks=1 synth=2562ms play=0ms total=2566ms"),
    ).toEqual({ engine: "sherpa", daemonForm: null, totalMs: 2566 });
  });

  it("解析 daemon=warm 形态", () => {
    expect(
      parseDebugLine("say: debug: engine=indextts daemon=warm voice=frieren-zh chunks=1 synth=4025ms play=0ms total=4030ms"),
    ).toEqual({ engine: "indextts", daemonForm: "warm", totalMs: 4030 });
  });

  it("非 debug 行与缺失键返回 null", () => {
    expect(parseDebugLine("say: fallback: system 走起")).toBeNull();
    expect(parseDebugLine("")).toBeNull();
  });
});

describe("sayArgs", () => {
  it("engine/voice 缺省时只有 -o、-- 分隔与文本", () => {
    expect(sayArgs({ text: "你好", out: "/tmp/x.wav" })).toEqual(["-o", "/tmp/x.wav", "--", "你好"]);
  });

  it("engine/voice 显式时按 flag 顺序拼装", () => {
    expect(sayArgs({ text: "hi", engine: "indextts", voice: "frieren-zh", out: "/tmp/x.wav" })).toEqual([
      "--engine",
      "indextts",
      "--voice",
      "frieren-zh",
      "-o",
      "/tmp/x.wav",
      "--",
      "hi",
    ]);
  });

  it("- 开头的正文经 -- 分隔不落入透传分支", () => {
    expect(sayArgs({ text: "-v hi", out: "/tmp/x.wav" })).toEqual(["-o", "/tmp/x.wav", "--", "-v hi"]);
  });
});

const fakeRunner = (opts: {
  code: number;
  stderr?: string;
}): SayRunner => {
  return async (args) => {
    const outIdx = args.indexOf("-o");
    const out = args[outIdx + 1];
    if (opts.code === 0) writeFileSync(out, RIFF);
    return { code: opts.code, stderr: opts.stderr ?? "" };
  };
};

describe("synthesize", () => {
  it("成功路径回传 wav 字节与引擎归因（debug 行驱动）", async () => {
    const r = await synthesize(
      { text: "工作台新文本", engine: "indextts", voice: "frieren-zh" },
      { runner: fakeRunner({ code: 0, stderr: "say: debug: engine=indextts daemon=warm voice=frieren-zh chunks=1 synth=4025ms play=0ms total=4030ms" }) },
    );
    expect(r.wav.equals(RIFF)).toBe(true);
    expect(r.engine).toBe("indextts");
    expect(r.daemonForm).toBe("warm");
    expect(r.totalMs).toBe(4030);
    expect(r.fallback).toBe(false);
  });

  it("stderr 出现 fallback 行时标记回退", async () => {
    const r = await synthesize(
      { text: "x" },
      {
        runner: fakeRunner({
          code: 0,
          stderr: "say: fallback: voxcpm 失败走系统嗓\nsay: debug: engine=system voice=default chunks=1 synth=1800ms play=0ms total=1805ms",
        }),
      },
    );
    expect(r.fallback).toBe(true);
    expect(r.engine).toBe("system");
  });

  it("非零退出抛 SayError 带退出码与 stderr 摘要", async () => {
    await expect(
      synthesize({ text: "x" }, { runner: fakeRunner({ code: 1, stderr: "boom" }) }),
    ).rejects.toMatchObject({ code: 1 } satisfies Partial<SayError>);
  });

  it("空文本直接拒绝，不起子进程", async () => {
    await expect(synthesize({ text: "  " }, { runner: fakeRunner({ code: 0 }) })).rejects.toThrow();
  });

  it("超 1000 字文本拒绝", async () => {
    await expect(
      synthesize({ text: "长".repeat(1001) }, { runner: fakeRunner({ code: 0 }) }),
    ).rejects.toThrow("1000");
  });
});
