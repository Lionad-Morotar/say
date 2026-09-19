import { describe, expect, it } from "vitest";
import { SYSTEM_ENGINE, createRegistry, createSherpaEngine, createSystemEngine } from "../src/engines/index.ts";
import type { SherpaSynth } from "../src/engines/sherpa.ts";
import { EngineError } from "../src/errors.ts";
import { resolvePaths } from "../src/paths.ts";
import { run } from "../src/speak.ts";
import { createFakeHost, type FakeHostOptions } from "./fake-host.ts";

const SAY = "/usr/bin/say";
const TMP = "/var/tmp";
const MODELS = "/cache/models";
const KOKORO = `${MODELS}/sherpa/kokoro-multi-lang-v1_1`;
const CONFIG = "/h/.config/say/config.toml";

const KOKORO_FILES: Record<string, string> = {
  [`${KOKORO}/model.onnx`]: "",
  [`${KOKORO}/voices.bin`]: "",
  [`${KOKORO}/tokens.txt`]: "",
  [`${KOKORO}/espeak-ng-data`]: "",
  [`${KOKORO}/lexicon-us-en.txt`]: "",
  [`${KOKORO}/lexicon-zh.txt`]: "",
  [`${KOKORO}/date-zh.fst`]: "",
  [`${KOKORO}/number-zh.fst`]: "",
};

const SAMPLES = new Float32Array([0.2, -0.3, 0.4]);

const okSynth: SherpaSynth = async () => ({ samples: SAMPLES, sampleRate: 24000, numSpeakers: 103 });
const brokenSynth: SherpaSynth = async () => {
  throw new EngineError("sherpa kokoro 返回的样本全为 NaN");
};

interface InvokeOptions extends FakeHostOptions {
  synth?: SherpaSynth;
  /** 模型资产是否在盘：false 表示只装了系统嗓 */
  withModels?: boolean;
}

async function invoke(options: InvokeOptions, argv: readonly string[]) {
  const { synth = okSynth, withModels = true, ...hostOptions } = options;
  const files = { [SAY]: "", ...(withModels ? KOKORO_FILES : {}), ...hostOptions.files };
  const fake = createFakeHost({ tmpDir: TMP, ...hostOptions, env: { HOME: "/h", ...hostOptions.env }, files });
  const code = await run(argv, {
    host: fake.host,
    paths: resolvePaths(fake.host.env),
    registry: createRegistry([
      createSherpaEngine({ host: fake.host, modelsDir: MODELS, synth }),
      createSystemEngine(fake.host, SAY),
    ]),
    sayBin: SAY,
  });
  return { code, ...fake, text: () => fake.stderr.join("") };
}

/** 回退是否真的发生：以「系统嗓被调起」为准，而不是只看退出码 */
function fellBack(spawns: readonly { cmd: string }[]): boolean {
  return spawns.some((spawn) => spawn.cmd === SAY);
}

describe("引擎不可用时回退到系统嗓", () => {
  it("模型缺失即回退，出声因此 exit 0", async () => {
    const { code, spawns } = await invoke({ withModels: false }, ["-o", "/out/a.wav", "hi"]);
    expect(code).toBe(0);
    expect(fellBack(spawns)).toBe(true);
  });

  it("stderr 恰好一行 fallback 原因，并点名缺失文件", async () => {
    const { text } = await invoke({ withModels: false }, ["-o", "/out/a.wav", "hi"]);
    const lines = text().split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^say: fallback: /);
    expect(lines[0]).toContain("model.onnx");
  });

  it("回退产物走同一 PID 临时名再原子改名，交付契约不因回退而分叉", async () => {
    const { code, spawns, renames } = await invoke({ withModels: false, pid: 4242 }, ["-o", "/out/a.wav", "hi"]);
    expect(code).toBe(0);
    const args = spawns[0]?.args ?? [];
    expect(args[args.indexOf("-o") + 1]).toBe("/out/a.wav.4242.tmp");
    expect(renames).toEqual([{ from: "/out/a.wav.4242.tmp", to: "/out/a.wav" }]);
  });

  it("回退路径不出声卡时不注入 -o，系统嗓自己播放，afplay 不参与", async () => {
    const { spawns } = await invoke({ withModels: false }, ["hi"]);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.args).not.toContain("-o");
    expect(spawns[0]?.cmd).not.toBe("/usr/bin/afplay");
  });

  it("音色名与语速原样带进回退调用，用户意图不在回退中丢失", async () => {
    const { spawns } = await invoke({ withModels: false }, ["-v", "af_maple", "-r", "220", "hi"]);
    const args = spawns[0]?.args ?? [];
    expect(args[args.indexOf("-v") + 1]).toBe("af_maple");
    expect(args[args.indexOf("-r") + 1]).toBe("220");
  });
});

describe("合成失败时回退", () => {
  it("引擎抛错即回退，exit 0 且 stderr 带上原始失败原因", async () => {
    const { code, text } = await invoke({ synth: brokenSynth }, ["-o", "/out/a.wav", "hi"]);
    expect(code).toBe(0);
    expect(text()).toContain("say: fallback:");
    expect(text()).toContain("NaN");
  });

  it("主引擎失败后不落任何产物残骸，最终文件由系统嗓产出", async () => {
    const { writes, renames } = await invoke({ synth: brokenSynth, pid: 7 }, ["-o", "/out/a.wav", "hi"]);
    expect(writes).toHaveLength(0);
    expect(renames).toEqual([{ from: "/out/a.wav.7.tmp", to: "/out/a.wav" }]);
  });
});

describe("未登记引擎名", () => {
  it("回退而非直接失败：写错引擎名不该让 say 哑掉", async () => {
    const { code, spawns, text } = await invoke({ env: { SAY_ENGINE: "nonexistent" } }, ["-o", "/out/a.wav", "hi"]);
    expect(code).toBe(0);
    expect(fellBack(spawns)).toBe(true);
    expect(text()).toContain("nonexistent");
    expect(text()).toContain("say: fallback:");
  });
});

describe("fallback = off", () => {
  it("配置文件关闭回退时按失败退出，且不调起系统嗓", async () => {
    const { code, spawns, text } = await invoke(
      { withModels: false, files: { [CONFIG]: 'fallback = "off"\n' } },
      ["-o", "/out/a.wav", "hi"],
    );
    expect(code).toBe(1);
    expect(fellBack(spawns)).toBe(false);
    expect(text()).not.toContain("fallback:");
    expect(text()).toContain("model.onnx");
  });

  it("环境变量关闭回退同样生效，优先级高于配置文件", async () => {
    const { code, spawns } = await invoke(
      { withModels: false, env: { SAY_FALLBACK: "off" }, files: { [CONFIG]: 'fallback = "system"\n' } },
      ["hi"],
    );
    expect(code).toBe(1);
    expect(fellBack(spawns)).toBe(false);
  });
});

describe("回退本身失败", () => {
  it("系统嗓也不可用时 exit 1，两段原因都在 stderr 里", async () => {
    const fake = createFakeHost({ tmpDir: TMP, files: {} });
    const code = await run(["hi"], {
      host: fake.host,
      paths: resolvePaths(fake.host.env),
      registry: createRegistry([
        createSherpaEngine({ host: fake.host, modelsDir: MODELS, synth: okSynth }),
        createSystemEngine(fake.host, SAY),
      ]),
      sayBin: SAY,
    });
    expect(code).toBe(1);
    expect(fake.stderr.join("")).toContain(SAY);
  });

  it("回退调用自己失败时 exit 1，不会无限重试", async () => {
    const { code, spawns } = await invoke(
      { withModels: false, spawnOutcome: () => ({ exitCode: 1, signal: null, stdout: "", stderr: "say: boomed" }) },
      ["hi"],
    );
    expect(code).toBe(1);
    expect(spawns).toHaveLength(1);
  });

  it("选中的就是系统嗓时失败不回退到自己，只调起一次", async () => {
    const { code, spawns, text } = await invoke(
      { env: { SAY_ENGINE: "system" }, spawnOutcome: () => ({ exitCode: 1, signal: null, stdout: "", stderr: "boom" }) },
      ["hi"],
    );
    expect(code).toBe(1);
    expect(spawns).toHaveLength(1);
    expect(text()).not.toContain("say: fallback:");
  });

  it("注册表里没有系统嗓时按失败退出，回退目标缺失不被静默吞掉", async () => {
    const fake = createFakeHost({ tmpDir: TMP, files: { [SAY]: "" } });
    const code = await run(["hi"], {
      host: fake.host,
      paths: resolvePaths(fake.host.env),
      registry: createRegistry([createSherpaEngine({ host: fake.host, modelsDir: MODELS, synth: brokenSynth })]),
      sayBin: SAY,
    });
    expect(code).toBe(1);
    expect(fake.stderr.join("")).toContain(SYSTEM_ENGINE);
  });
});

describe("回退不被无故触发", () => {
  it("主引擎成功时不出现 fallback 行，也不调起系统嗓", async () => {
    const { code, spawns, text } = await invoke({}, ["-o", "/out/a.wav", "hi"]);
    expect(code).toBe(0);
    expect(text()).toBe("");
    expect(fellBack(spawns)).toBe(false);
  });

  it("空正文短路优先于回退，不产生任何调用", async () => {
    const { code, spawns, text } = await invoke({ withModels: false, stdin: "  \n" }, []);
    expect(code).toBe(0);
    expect(spawns).toHaveLength(0);
    expect(text()).toBe("");
  });

  it("用法错误优先于回退，退出码仍是 2", async () => {
    const { code, spawns } = await invoke({ withModels: false }, ["-r", "abc", "hi"]);
    expect(code).toBe(2);
    expect(spawns).toHaveLength(0);
  });

  it("透传路径不参与回退，原样转交并继承退出码", async () => {
    const { code, spawns, text } = await invoke(
      { withModels: false, spawnOutcome: () => ({ exitCode: 3, signal: null, stdout: "", stderr: "" }) },
      ["--progress", "hi"],
    );
    expect(code).toBe(3);
    expect(spawns[0]?.args).toEqual(["--progress", "hi"]);
    expect(text()).toBe("");
  });
});
