import { describe, expect, it } from "vitest";
import { createRegistry, createSystemEngine } from "../src/engines/index.ts";
import { EngineError } from "../src/errors.ts";
import type { SpawnOpts } from "../src/host.ts";
import { chunkText } from "../src/normalize.ts";
import { AFPLAY_BIN } from "../src/player.ts";
import { resolvePaths } from "../src/paths.ts";
import { run } from "../src/speak.ts";
import type { AudioOut, EngineAdapter, SpeakOptions } from "../src/types.ts";
import { createFakeHost } from "./fake-host.ts";

const SAY = "/usr/bin/say";
const TMP = "/var/tmp";

/** 单个子块的产出或失败标记；外层数组 = 文本块，内层数组 = 引擎内流式子块序列 */
type Step = { samples: number[] } | "fail";

/** 造超过分块阈值的正文：与 speak-chunked 同款，块数从规范化层取（这里验的是编排接缝，不是分块本身） */
function longText(sentences: number, words = 20): string {
  const one = `${Array.from({ length: words }, (_, i) => `w${i}`.padEnd(3, "x")).join(" ")}.`;
  return Array.from({ length: sentences }, () => one).join(" ");
}

const LONG = longText(40);
const CHUNKS = chunkText(LONG).length;

/** 每块都成功的脚本：subblocks = 每个文本块的流式子块数 */
function okScript(subblocks = 2): Step[][] {
  return Array.from({ length: CHUNKS }, () => Array.from({ length: subblocks }, () => ({ samples: [0.1] })));
}

/** 第 index 块首块之前失败的脚本 */
function failAtBlock(index: number): Step[][] {
  return Array.from({ length: CHUNKS }, (_, i) => (i === index ? ["fail"] : [{ samples: [0.1] }]));
}

/** 带引擎内流式能力的假引擎：speak 是流式收集（与 voxcpm adapter 同构），speakStreaming 逐块转交 */
function makeStreamingEngine(script: Step[][]): EngineAdapter {
  const collect = async function* (call: number): AsyncGenerator<Extract<AudioOut, { type: "pcm" }>> {
    const steps = script[call];
    if (steps === undefined) throw new EngineError(`第 ${call} 块无脚本`);
    for (const step of steps) {
      if (step === "fail") throw new EngineError(`第 ${call} 块流式子块炸了`);
      yield { type: "pcm", samples: Float32Array.from(step.samples), sampleRate: 48000 };
    }
  };
  let speakCall = 0;
  let streamCall = 0;
  return {
    name: "streamfake",
    chunkable: true,
    async isAvailable() {
      return { ok: true };
    },
    async listVoices() {
      return [];
    },
    async speak(_text: string, _opts: SpeakOptions): Promise<AudioOut> {
      const parts: Float32Array[] = [];
      let sampleRate = 0;
      for await (const out of collect(speakCall++)) {
        sampleRate = out.sampleRate;
        parts.push(out.samples);
      }
      return { type: "pcm", samples: Float32Array.from(parts.flatMap((p) => [...p])), sampleRate };
    },
    speakStreaming: () => collect(streamCall++),
  };
}

async function invoke(script: Step[][], argv: readonly string[], spawnOutcome?: (record: { cmd: string }) => { exitCode: number; signal: null; stdout: string; stderr: string }) {
  // /usr/bin/say 在 files 表 = system 回退引擎可用（回退链测试的前提）
  const fake = createFakeHost({
    tmpDir: TMP,
    env: { HOME: "/h" },
    files: { [SAY]: "" },
    ...(spawnOutcome === undefined ? {} : { spawnOutcome }),
  });
  const innerSpawn = fake.host.spawn;
  const plays: string[] = [];
  fake.host.spawn = async (cmd: string, args: readonly string[], spawnOpts?: SpawnOpts) => {
    if (cmd === AFPLAY_BIN) plays.push(args[0]!);
    return innerSpawn(cmd, args, spawnOpts);
  };
  const exit = await run(argv, {
    host: fake.host,
    paths: resolvePaths(fake.host.env),
    registry: createRegistry([makeStreamingEngine(script), createSystemEngine(fake.host, SAY)]),
    sayBin: SAY,
  });
  return {
    code: exit,
    plays,
    spawns: fake.spawns,
    writes: fake.writes,
    renames: fake.renames,
    removes: fake.removes,
    stderr: fake.stderr,
    text: () => fake.stderr.join(""),
  };
}

describe("引擎内流式：出声卡路径（S4 接缝）", () => {
  it("每个流式子块各写各的暂存 wav 并各播一次，播完即删", async () => {
    const { code, writes, plays, removes } = await invoke(okScript(), ["--engine", "streamfake", LONG]);
    expect(code).toBe(0);
    const staged = Array.from({ length: CHUNKS * 2 }, (_, i) => `${TMP}/say-4242-${i}.wav`);
    expect(writes.map((write) => write.path)).toEqual(staged);
    expect(plays).toEqual(staged);
    expect(removes).toEqual(staged);
  });

  it("-o 模式不走流式交付：speak 收集整句拼成单文件", async () => {
    const { code, writes, renames, plays } = await invoke(okScript(), ["--engine", "streamfake", "-o", "/out/a.wav", LONG]);
    expect(code).toBe(0);
    expect(plays).toHaveLength(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe("/out/a.wav.4242.tmp");
    expect(renames).toEqual([{ from: "/out/a.wav.4242.tmp", to: "/out/a.wav" }]);
  });

  it("首块之前失败：整体按全文回退到系统嗓", async () => {
    const { code, spawns, text } = await invoke([["fail"]], ["--engine", "streamfake", "全文就一句"]);
    expect(code).toBe(0);
    expect(text()).toContain("say: fallback:");
    const say = spawns.find((spawn) => spawn.cmd === SAY);
    expect(say?.stdin).toBe("全文就一句");
  });

  it("后续文本块首块之前失败：剩余文本交回退引擎，不重播前半段", async () => {
    const { code, spawns, text, plays } = await invoke(failAtBlock(1), ["--engine", "streamfake", LONG]);
    expect(code).toBe(0);
    expect(text()).toContain("say: fallback:");
    expect(plays).toHaveLength(1); // 只有第 0 块的唯一子块出了声
    const spoken = spawns.find((spawn) => spawn.cmd === SAY)?.stdin ?? "";
    // 剩余文本精确从失败块起（不重播已听内容），长度上必短于全文
    expect(spoken.length).toBeLessThan(LONG.length);
    expect(spoken).toBe(chunkText(LONG).slice(1).join(" "));
  });

  it("文本块内中途失败：已出声部分不重播也不回退，原因一行 exit 0", async () => {
    const midFail: Step[][] = [[{ samples: [0.1] }, "fail", { samples: [0.3] }]];
    const { code, spawns, text, plays } = await invoke(midFail, ["--engine", "streamfake", "同一句的连续段"]);
    expect(code).toBe(0);
    expect(text()).toContain("合成失败");
    expect(text()).not.toContain("fallback:");
    expect(plays).toHaveLength(1);
    expect(spawns.find((spawn) => spawn.cmd === SAY)).toBeUndefined();
  });

  it("播放失败即整体失败 exit 1，原因可见", async () => {
    const { code, text } = await invoke(
      okScript(1),
      ["--engine", "streamfake", LONG],
      (record) =>
        record.cmd === AFPLAY_BIN
          ? { exitCode: 1, signal: null, stdout: "", stderr: "AudioFileOpen failed" }
          : { exitCode: 0, signal: null, stdout: "", stderr: "" },
    );
    expect(code).toBe(1);
    expect(text()).toContain("AudioFileOpen failed");
  });

  it("debug 摘要的 synth 是开口延迟（首块前等待），不是整句合成时长", async () => {
    const fake = createFakeHost({ tmpDir: TMP, env: { HOME: "/h", SAY_DEBUG: "1" } });
    let tick = 0;
    fake.host.now = () => (tick += 5);
    await run(["--engine", "streamfake", LONG], {
      host: fake.host,
      paths: resolvePaths(fake.host.env),
      registry: createRegistry([makeStreamingEngine(okScript(1)), createSystemEngine(fake.host, SAY)]),
      sayBin: SAY,
    });
    const line = fake.stderr.join("").split("\n").find((row) => row.startsWith("say: debug:")) ?? "";
    const synth = Number(line.match(/synth=(\d+)ms/)?.[1] ?? -1);
    // 恒步进假时钟下首块前等待是一次 now() 差（5ms 量级），远小于全部块的合成总耗时
    expect(synth).toBeGreaterThan(0);
    expect(synth).toBeLessThanOrEqual(10);
  });
});
