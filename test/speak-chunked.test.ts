import { describe, expect, it } from "vitest";
import { createRegistry, createSherpaEngine, createSystemEngine } from "../src/engines/index.ts";
import type { SherpaSynth, SherpaSynthRequest } from "../src/engines/sherpa.ts";
import { EngineError } from "../src/errors.ts";
import type { SpawnOpts } from "../src/host.ts";
import { chunkText } from "../src/normalize.ts";
import { AFPLAY_BIN } from "../src/player.ts";
import { resolvePaths } from "../src/paths.ts";
import { run } from "../src/speak.ts";
import { createFakeHost, type FakeHostOptions } from "./fake-host.ts";

const SAY = "/usr/bin/say";
const TMP = "/var/tmp";
const MODELS = "/cache/models";
const KOKORO = `${MODELS}/sherpa/kokoro-multi-lang-v1_1`;

const KOKORO_FILES: Record<string, string> = {
  [SAY]: "",
  [`${KOKORO}/model.onnx`]: "",
  [`${KOKORO}/voices.bin`]: "",
  [`${KOKORO}/tokens.txt`]: "",
  [`${KOKORO}/espeak-ng-data`]: "",
  [`${KOKORO}/lexicon-us-en.txt`]: "",
  [`${KOKORO}/lexicon-zh.txt`]: "",
  [`${KOKORO}/date-zh.fst`]: "",
  [`${KOKORO}/number-zh.fst`]: "",
};

/** 造一段超过分块阈值的英文：三字符词加一个空格正好四字符，约一个近似 token */
function longText(sentences: number, words = 20): string {
  const one = `${Array.from({ length: words }, (_, i) => `w${i}`.padEnd(3, "x")).join(" ")}.`;
  return Array.from({ length: sentences }, () => one).join(" ");
}

const LONG = longText(40);
const SAMPLES = new Float32Array([0.2, -0.3, 0.4]);
/** 块数取自规范化层而不是写死：这里要验的是编排层用了同一套分块，不是分块本身怎么切 */
const CHUNKS = chunkText(LONG).length;

/** 分块播放的暂存 wav 落点，块序号进文件名，PID 保证并发调用互不干扰 */
function stagedOf(pid: number): string[] {
  return Array.from({ length: CHUNKS }, (_, i) => `${TMP}/say-${pid}-${i}.wav`);
}

interface SynthOptions {
  /** 从第几块开始抛错，用于测中途失败的收尾 */
  failFrom?: number;
  sampleRateOf?: (index: number) => number;
  /** 第几块合成耗时多少毫秒：让「下一块还在飞」这件事在时间线上可分辨 */
  delayOf?: (index: number) => number;
}

interface InvokeOptions extends FakeHostOptions, SynthOptions {
  clock?: () => number;
  /**
   * 假时钟只在合成与播放里走字。摘要的分项耗时因此成为可精确断言的量，
   * 而不是「每次 now() 加一」那种与实现调用次数耦合的数字。
   */
  advance?: { synth?: number; spawn?: number };
}

/** 单调递增的假时钟：真实 host 的 now() 在测试里恒为 0，测不出耗时字段是否真的在计时 */
function clock(step = 7): () => number {
  let tick = 0;
  return () => (tick += step);
}

/** 摘要行的三个耗时字段。缺失取 -1，断言失败时能看出是「没这行」而不是「数值不对」 */
function debugFields(text: string): { synth: number; play: number; total: number } {
  const line = text.split("\n").find((row) => row.startsWith("say: debug:")) ?? "";
  const ms = (key: string): number => Number(line.match(new RegExp(`${key}=(\\d+)ms`))?.[1] ?? -1);
  return { synth: ms("synth"), play: ms("play"), total: ms("total") };
}

/**
 * 合成与播放事件写进同一条时间线。流水播放是「谁先谁后」的性质，
 * 用时长测不出来——假 host 的 spawn 瞬时返回，只能靠事件顺序判定。
 */
async function invoke(options: InvokeOptions, argv: readonly string[]) {
  const timeline: string[] = [];
  const calls: SherpaSynthRequest[] = [];
  let virtual = 0;
  const synth: SherpaSynth = async (request) => {
    const index = calls.length;
    calls.push(request);
    timeline.push(`synth-start:${index}`);
    try {
      const delay = options.delayOf?.(index) ?? 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      virtual += options.advance?.synth ?? 0;
      if (options.failFrom !== undefined && index >= options.failFrom) {
        throw new EngineError(`第 ${index} 块合成炸了`);
      }
      return {
        samples: SAMPLES,
        sampleRate: options.sampleRateOf?.(index) ?? 24000,
        numSpeakers: 103,
      };
    } finally {
      timeline.push(`synth-end:${index}`);
    }
  };

  const { clock: tick, failFrom, sampleRateOf, delayOf, advance, ...hostOptions } = options;
  const fake = createFakeHost({
    tmpDir: TMP,
    files: KOKORO_FILES,
    ...hostOptions,
    // exactOptionalPropertyTypes 下不能把可能为 undefined 的字段直接塞进去
    ...(tick === undefined && advance === undefined ? {} : { now: tick ?? (() => virtual) }),
    env: { HOME: "/h", ...options.env },
  });
  const innerSpawn = fake.host.spawn;
  fake.host.spawn = async (cmd: string, args: readonly string[], spawnOpts?: SpawnOpts) => {
    timeline.push(cmd === AFPLAY_BIN ? `play:${args[0]}` : `say:${args.join(" ")}`);
    const outcome = await innerSpawn(cmd, args, spawnOpts);
    virtual += advance?.spawn ?? 0;
    return outcome;
  };
  // 原因行落在时间线上，才能判定它是写在飞行中的那块合成之前还是之后
  const innerWriteStderr = fake.host.writeStderr;
  fake.host.writeStderr = (text: string) => {
    timeline.push(`stderr:${text.trimEnd()}`);
    innerWriteStderr(text);
  };
  const code = await run(argv, {
    host: fake.host,
    paths: resolvePaths(fake.host.env),
    registry: createRegistry([
      createSherpaEngine({ host: fake.host, modelsDir: MODELS, synth }),
      createSystemEngine(fake.host, SAY),
    ]),
    sayBin: SAY,
  });
  return {
    code,
    calls,
    timeline,
    spawns: fake.spawns,
    writes: fake.writes,
    renames: fake.renames,
    removes: fake.removes,
    stderr: fake.stderr,
    text: () => fake.stderr.join(""),
  };
}

describe("长文本分块：合成调用面", () => {
  it("超过阈值的正文按句边界切成多块，每块各调一次合成", async () => {
    const { code, calls } = await invoke({}, ["-o", "/out/a.wav", LONG]);
    expect(code).toBe(0);
    expect(calls).toHaveLength(CHUNKS);
  });

  it("首块预算小于后续块：首次出声不必等整段合成完", async () => {
    const { calls } = await invoke({}, ["-o", "/out/a.wav", LONG]);
    expect(calls[0]!.text.length).toBeLessThan(calls[1]!.text.length);
  });

  it("分块不丢字也不重复：拼回去与原文同一字符集", async () => {
    const { calls } = await invoke({}, ["-o", "/out/a.wav", LONG]);
    const joined = calls.map((call) => call.text).join("");
    expect(joined.replace(/\s+/g, "")).toBe(LONG.replace(/\s+/g, ""));
  });

  it("阈值内的正文只合成一次，分块不是无条件的", async () => {
    const { calls } = await invoke({}, ["-o", "/out/a.wav", "hello there"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe("hello there");
  });

  it("系统嗓不参与分块：say 自己没有单次长度上限，切开只会多出边界停顿", async () => {
    const { code, spawns, calls } = await invoke({ env: { SAY_ENGINE: "system" } }, [LONG]);
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.stdin).toBe(LONG);
  });
});

describe("长文本分块：-o 合并为单文件", () => {
  it("全部块的样本拼成一个 wav，只写一次只改名一次", async () => {
    const { code, writes, renames } = await invoke({ pid: 77 }, ["-o", "/out/a.wav", LONG]);
    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe("/out/a.wav.77.tmp");
    expect(writes[0]?.bytes.byteLength).toBe(44 + SAMPLES.length * 2 * CHUNKS);
    expect(renames).toEqual([{ from: "/out/a.wav.77.tmp", to: "/out/a.wav" }]);
  });

  it("-o 模式不出声：合并产物落盘就够了", async () => {
    const { spawns } = await invoke({}, ["-o", "/out/a.wav", LONG]);
    expect(spawns.map((spawn) => spawn.cmd)).not.toContain(AFPLAY_BIN);
  });

  it("块间采样率不一致即判失败，不拼出一个变调的 wav", async () => {
    const { code, spawns, text } = await invoke(
      { sampleRateOf: (index) => (index === 0 ? 24000 : 22050) },
      ["-o", "/out/a.wav", LONG],
    );
    expect(code).toBe(0);
    expect(text()).toContain("采样率");
    expect(spawns[0]?.cmd).toBe(SAY);
  });
});

describe("长文本分块：流水播放", () => {
  it("每块各写各的暂存 wav、各播一次、播完即删", async () => {
    const { code, writes, spawns, removes } = await invoke({ pid: 77 }, [LONG]);
    expect(code).toBe(0);
    const staged = stagedOf(77);
    expect(writes.map((write) => write.path)).toEqual(staged);
    expect(spawns.filter((spawn) => spawn.cmd === AFPLAY_BIN)).toHaveLength(CHUNKS);
    expect(removes).toEqual(staged);
  });

  it("播块 i 时块 i+1 的合成已经发起，而不是播完才开始合成", async () => {
    const { timeline } = await invoke({}, [LONG]);
    expect(timeline.indexOf("synth-start:1")).toBeLessThan(timeline.indexOf(`play:${TMP}/say-4242-0.wav`));
  });

  it("播放按块顺序推进，不会把后面的块先播出去", async () => {
    const { timeline } = await invoke({}, [LONG]);
    expect(timeline.filter((event) => event.startsWith("play:"))).toEqual(stagedOf(4242).map((path) => `play:${path}`));
  });

  it("并发调用各写各的暂存名：PID 与块序号一起才够唯一", async () => {
    const a = await invoke({ pid: 111 }, [LONG]);
    const b = await invoke({ pid: 222 }, [LONG]);
    expect(a.writes[0]?.path).toBe(`${TMP}/say-111-0.wav`);
    expect(b.writes[0]?.path).toBe(`${TMP}/say-222-0.wav`);
  });
});

describe("长文本分块：中途失败的收尾", () => {
  it("首块就失败时按全文回退到系统嗓，与单块路径同一口径", async () => {
    const { code, spawns, text } = await invoke({ failFrom: 0 }, [LONG]);
    expect(code).toBe(0);
    expect(text()).toContain("say: fallback:");
    expect(spawns[0]?.cmd).toBe(SAY);
    expect(spawns[0]?.stdin).toBe(LONG);
  });

  it("已经出过声时只把剩余文本交给回退引擎，不重播前半段", async () => {
    const { code, spawns, text } = await invoke({ failFrom: 2 }, [LONG]);
    expect(code).toBe(0);
    expect(text()).toContain("say: fallback:");
    const spoken = spawns.find((spawn) => spawn.cmd === SAY)?.stdin ?? "";
    expect(spoken.length).toBeLessThan(LONG.length);
    expect(LONG.endsWith(spoken)).toBe(true);
    expect(spawns.filter((spawn) => spawn.cmd === AFPLAY_BIN)).toHaveLength(2);
  });

  it("已经出过声且回退也不可用时仍是 exit 0，原因留在 stderr", async () => {
    const fake = createFakeHost({ tmpDir: TMP, env: { HOME: "/h" }, files: KOKORO_FILES });
    let index = 0;
    const synth: SherpaSynth = async () => {
      index += 1;
      if (index > 2) throw new EngineError("第三块炸了");
      return { samples: SAMPLES, sampleRate: 24000, numSpeakers: 103 };
    };
    const code = await run([LONG], {
      host: fake.host,
      paths: resolvePaths(fake.host.env),
      registry: createRegistry([createSherpaEngine({ host: fake.host, modelsDir: MODELS, synth })]),
      sayBin: SAY,
    });
    expect(code).toBe(0);
    expect(fake.stderr.join("")).toContain("回退引擎");
  });

  it("回退关闭且首块失败时按失败退出，不碰系统嗓", async () => {
    const { code, spawns, text } = await invoke({ env: { SAY_FALLBACK: "off" }, failFrom: 0 }, [LONG]);
    expect(code).toBe(1);
    expect(spawns).toHaveLength(0);
    expect(text()).not.toContain("fallback:");
  });

  it("播放失败即整体失败，已经出过声也不算交付成功", async () => {
    const { code, text } = await invoke(
      { spawnOutcome: () => ({ exitCode: 1, signal: null, stdout: "", stderr: "AudioFileOpen failed" }) },
      [LONG],
    );
    expect(code).toBe(1);
    expect(text()).toContain("AudioFileOpen failed");
  });

  it("写原因行之前先等在飞的那块合成落地：它的 fd 2 遮罩还开着，这时写等于写进 /dev/null", async () => {
    // 第 3 块 30ms 后抛错，第 4 块 40ms 后抛错。收尾若不等第 4 块，原因行会抢在 40ms 之前写出
    const { code, timeline, text } = await invoke({ failFrom: 2, delayOf: (index) => index * 10 }, [LONG]);
    expect(code).toBe(0);
    expect(text()).toContain("say: fallback:");
    const settled = timeline.indexOf("synth-end:3");
    const reason = timeline.findIndex((event) => event.startsWith("stderr:say: fallback:"));
    expect(settled).toBeGreaterThan(-1);
    expect(reason).toBeGreaterThan(settled);
  });

  it("播放失败时同样等在飞的那块落地，否则 exit 1 连一句原因都留不下", async () => {
    const { code, timeline } = await invoke(
      {
        spawnOutcome: (record) =>
          record.cmd === AFPLAY_BIN
            ? { exitCode: 1, signal: null, stdout: "", stderr: "AudioFileOpen failed" }
            : { exitCode: 0, signal: null, stdout: "", stderr: "" },
        delayOf: (index) => index * 10,
      },
      [LONG],
    );
    expect(code).toBe(1);
    const settled = timeline.indexOf("synth-end:1");
    const reason = timeline.findIndex((event) => event.includes("AudioFileOpen failed"));
    expect(settled).toBeGreaterThan(-1);
    expect(reason).toBeGreaterThan(settled);
  });

  it("-o 模式下任一块失败即整段回退，不留半截合并产物", async () => {
    const { code, writes, renames, spawns } = await invoke({ failFrom: 3 }, ["-o", "/out/a.wav", LONG]);
    expect(code).toBe(0);
    expect(spawns[0]?.cmd).toBe(SAY);
    expect(writes).toHaveLength(0);
    expect(renames).toEqual([{ from: "/out/a.wav.4242.tmp", to: "/out/a.wav" }]);
  });
});

describe("SAY_DEBUG=1 的时序摘要", () => {
  it("一行给出引擎、音色、块数与合成/播放/总耗时", async () => {
    const { text } = await invoke({ env: { SAY_DEBUG: "1" }, clock: clock() }, ["-o", "/out/a.wav", LONG]);
    const line = text()
      .split("\n")
      .find((row) => row.startsWith("say: debug:"));
    expect(line).toBeDefined();
    expect(line).toContain("engine=sherpa");
    expect(line).toContain("voice=default");
    expect(line).toContain(`chunks=${CHUNKS}`);
    expect(line).toMatch(/synth=[1-9]\d*ms/);
    expect(line).toMatch(/total=[1-9]\d*ms/);
  });

  it("出声卡模式下播放耗时也被记进摘要", async () => {
    const { text } = await invoke({ env: { SAY_DEBUG: "1" }, clock: clock() }, [LONG]);
    expect(text()).toMatch(/play=[1-9]\d*ms/);
  });

  it("回退发生时摘要记的是真正出声的引擎", async () => {
    const { text } = await invoke({ env: { SAY_DEBUG: "1" }, clock: clock(), failFrom: 0 }, ["-o", "/out/a.wav", LONG]);
    expect(text()).toContain("engine=system");
  });

  it("回退那一腿的耗时也进摘要：落盘合并整段回退后分项之和等于 total", async () => {
    const { text } = await invoke(
      { env: { SAY_DEBUG: "1" }, advance: { synth: 100, spawn: 200 }, failFrom: 0 },
      ["-o", "/out/a.wav", LONG],
    );
    const { synth, play, total } = debugFields(text());
    expect(synth).toBe(300);
    expect(play).toBe(0);
    expect(synth + play).toBe(total);
  });

  it("回退引擎自己出声的那段算播放，不算合成", async () => {
    const { text } = await invoke(
      { env: { SAY_DEBUG: "1" }, advance: { synth: 100, spawn: 200 }, failFrom: 0 },
      ["hello"],
    );
    const { synth, play, total } = debugFields(text());
    expect(synth).toBe(100);
    expect(play).toBe(200);
    expect(synth + play).toBe(total);
  });

  it("已经出过声再回退，回退那一腿的播放时长同样被记进 play", async () => {
    const { text } = await invoke(
      { env: { SAY_DEBUG: "1" }, advance: { synth: 100, spawn: 200 }, failFrom: 2 },
      [LONG],
    );
    // 两块 afplay 各 200，加上回退那一腿 say 自己出声的 200
    expect(debugFields(text()).play).toBe(600);
  });

  it("未开 SAY_DEBUG 时一行摘要都不输出", async () => {
    const { text } = await invoke({}, ["-o", "/out/a.wav", LONG]);
    expect(text()).toBe("");
  });

  it("单块路径同样输出摘要，块数为 1", async () => {
    const { text } = await invoke({ env: { SAY_DEBUG: "1" }, clock: clock() }, ["-o", "/out/a.wav", "hello"]);
    expect(text()).toContain("chunks=1");
  });
});
