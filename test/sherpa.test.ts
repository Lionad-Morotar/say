import { describe, expect, it } from "vitest";
import {
  DEFAULT_VOICE,
  createSherpaEngine,
  wpmToSpeed,
  type SherpaSynth,
  type SherpaSynthRequest,
} from "../src/engines/sherpa.ts";
import { createRegistry, routeEngine } from "../src/engines/index.ts";
import { createSystemEngine } from "../src/engines/system.ts";
import { EngineError } from "../src/errors.ts";
import type { ResolvedConfig, SpeakOptions } from "../src/types.ts";
import { createFakeHost } from "./fake-host.ts";

const MODELS = "/cache/models";
const SHERPA = `${MODELS}/sherpa`;
const KOKORO_DIR = `${SHERPA}/kokoro-multi-lang-v1_1`;
const MATCHA_DIR = `${SHERPA}/matcha-icefall-zh-baker`;
const VOCODER = `${SHERPA}/vocoders/vocos-22khz-univ.onnx`;
const KOKORO_FILES = {
  [`${KOKORO_DIR}/model.onnx`]: "",
  [`${KOKORO_DIR}/voices.bin`]: "",
  [`${KOKORO_DIR}/tokens.txt`]: "",
  [`${KOKORO_DIR}/espeak-ng-data`]: "",
  [`${KOKORO_DIR}/lexicon-us-en.txt`]: "",
  [`${KOKORO_DIR}/lexicon-zh.txt`]: "",
  [`${KOKORO_DIR}/date-zh.fst`]: "",
  [`${KOKORO_DIR}/number-zh.fst`]: "",
};
const MATCHA_FILES = {
  [`${MATCHA_DIR}/model-steps-3.onnx`]: "",
  [`${MATCHA_DIR}/lexicon.txt`]: "",
  [`${MATCHA_DIR}/tokens.txt`]: "",
  [`${MATCHA_DIR}/date.fst`]: "",
  [`${MATCHA_DIR}/number.fst`]: "",
  [`${MATCHA_DIR}/phone.fst`]: "",
  [VOCODER]: "",
};

/** 假合成器：记录请求并返回可控样本，让适配器逻辑完全不触碰 native 绑定 */
function fakeSynth(result: Partial<Awaited<ReturnType<SherpaSynth>>> = {}) {
  const calls: SherpaSynthRequest[] = [];
  const synth: SherpaSynth = async (req) => {
    calls.push(req);
    return {
      samples: result.samples ?? new Float32Array([0.1, -0.2, 0.3]),
      sampleRate: result.sampleRate ?? 24000,
      numSpeakers: result.numSpeakers ?? (req.spec.kind === "kokoro" ? 103 : 1),
    };
  };
  return { synth, calls };
}

function makeEngine(synth: SherpaSynth, files: Record<string, string> = {}, replace = false) {
  const fake = createFakeHost({ env: { HOME: "/h" }, files: replace ? files : { ...KOKORO_FILES, ...files } });
  return { engine: createSherpaEngine({ host: fake.host, modelsDir: MODELS, synth }), fake };
}

const speakOpts = (over: Partial<SpeakOptions> = {}): SpeakOptions => ({
  voice: null,
  rateWpm: 175,
  output: null,
  ...over,
});

describe("wpmToSpeed：用户面 wpm 到 kokoro speed 倍率的换算", () => {
  it("175 wpm 是倍率 1.0 的锚点，与 macOS say 默认语速同值", () => {
    expect(wpmToSpeed(175)).toBe(1);
  });

  it("线性倍率：350 wpm → 2.0，87.5 wpm → 0.5", () => {
    expect(wpmToSpeed(350)).toBe(2);
    expect(wpmToSpeed(87.5)).toBe(0.5);
  });

  it("钳制在 [0.5, 2.0]：越界值不会让引擎产出数十秒或近乎瞬时的音频", () => {
    expect(wpmToSpeed(1)).toBe(0.5);
    expect(wpmToSpeed(0.001)).toBe(0.5);
    expect(wpmToSpeed(100000)).toBe(2);
  });
});

describe("createSherpaEngine.isAvailable：按待用音色对应的模型在盘与否判定", () => {
  it("kokoro 必需文件齐全即可用", async () => {
    const { engine } = makeEngine(fakeSynth().synth);
    expect(await engine.isAvailable(null)).toEqual({ ok: true });
  });

  it("缺 voices.bin 即不可用，原因点名缺失文件", async () => {
    const withoutVoices = Object.fromEntries(
      Object.keys(KOKORO_FILES)
        .filter((file) => !file.endsWith("voices.bin"))
        .map((file) => [file, ""]),
    );
    const fake = createFakeHost({ env: { HOME: "/h" }, files: withoutVoices });
    const engine = createSherpaEngine({ host: fake.host, modelsDir: MODELS, synth: fakeSynth().synth });
    const availability = await engine.isAvailable(null);
    expect(availability.ok).toBe(false);
    if (!availability.ok) expect(availability.reason).toContain("voices.bin");
  });

  it("解包不全时一次列全缺失项，不用修一个再撞下一个", async () => {
    const fake = createFakeHost({ env: { HOME: "/h" }, files: { [`${KOKORO_DIR}/tokens.txt`]: "" } });
    const engine = createSherpaEngine({ host: fake.host, modelsDir: MODELS, synth: fakeSynth().synth });
    const availability = await engine.isAvailable(null);
    expect(availability.ok).toBe(false);
    if (!availability.ok) {
      expect(availability.reason).toContain("model.onnx");
      expect(availability.reason).toContain("voices.bin");
      expect(availability.reason).toContain("espeak-ng-data");
    }
  });

  it("缺失原因报目录绝对路径加文件名，不把八个绝对路径拼成一行", async () => {
    const fake = createFakeHost({ env: { HOME: "/h" }, files: {} });
    const engine = createSherpaEngine({ host: fake.host, modelsDir: MODELS, synth: fakeSynth().synth });
    const availability = await engine.isAvailable(null);
    expect(availability.ok).toBe(false);
    if (!availability.ok) {
      expect(availability.reason).toContain(`${KOKORO_DIR} 缺少 8 项：`);
      expect(availability.reason).not.toContain(`${KOKORO_DIR}/model.onnx`);
    }
  });

  it("盘上只有 int8 权重时判不可用并点名缺失的 fp32 模型", async () => {
    const int8Only = Object.fromEntries(
      Object.keys(KOKORO_FILES).map((file) => [file.replace("model.onnx", "model.int8.onnx"), ""]),
    );
    const fake = createFakeHost({ env: { HOME: "/h" }, files: int8Only });
    const engine = createSherpaEngine({ host: fake.host, modelsDir: MODELS, synth: fakeSynth().synth });
    const availability = await engine.isAvailable(null);
    expect(availability.ok).toBe(false);
    if (!availability.ok) expect(availability.reason).toContain("model.onnx");
  });

  it("matcha 缺失不影响 kokoro 可用性：两者是并列音色来源而非依赖", async () => {
    const { engine } = makeEngine(fakeSynth().synth);
    expect((await engine.isAvailable(null)).ok).toBe(true);
    expect(await engine.listVoices()).toHaveLength(103);
  });

  it("只装了 matcha 时 matcha 音色可用，不被无关的 kokoro 缺失判死", async () => {
    const { engine } = makeEngine(fakeSynth().synth, MATCHA_FILES, true);
    expect((await engine.isAvailable("zh_baker")).ok).toBe(true);
    expect((await engine.isAvailable("baker")).ok).toBe(true);
  });

  it("只装了 matcha 时默认嗓不可用，原因指向 kokoro 资产而不是 matcha", async () => {
    const { engine } = makeEngine(fakeSynth().synth, MATCHA_FILES, true);
    const availability = await engine.isAvailable(null);
    expect(availability.ok).toBe(false);
    if (!availability.ok) expect(availability.reason).toContain("kokoro-multi-lang-v1_1");
  });

  it("只装了 kokoro 时 matcha 音色不可用，原因指向 matcha 资产", async () => {
    const { engine } = makeEngine(fakeSynth().synth);
    const availability = await engine.isAvailable("zh_baker");
    expect(availability.ok).toBe(false);
    if (!availability.ok) expect(availability.reason).toContain("matcha-icefall-zh-baker");
  });

  it("引擎认不出的音色名不在可用性层判死，留给合成层报精确原因", async () => {
    const { engine } = makeEngine(fakeSynth().synth);
    expect((await engine.isAvailable("Tingting")).ok).toBe(true);
    await expect(engine.speak("hi", speakOpts({ voice: "Tingting" }))).rejects.toThrow(/Tingting/);
  });

  it("matcha 齐全时其音色并入列举", async () => {
    const { engine } = makeEngine(fakeSynth().synth, MATCHA_FILES);
    const voices = await engine.listVoices();
    expect(voices).toHaveLength(105);
    expect(voices.find((voice) => voice.name === "zh_baker")).toEqual({
      name: "zh_baker",
      engine: "sherpa",
      lang: "zh",
    });
  });
});

describe("createSherpaEngine.speak：音色到模型与 sid 的路由", () => {
  it("未指定音色用默认嗓 af_maple，走 kokoro sid 0", async () => {
    const { synth, calls } = fakeSynth();
    const { engine } = makeEngine(synth);
    await engine.speak("hi", speakOpts());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.spec).toEqual({ kind: "kokoro", dir: KOKORO_DIR });
    expect(calls[0]?.sid).toBe(0);
    expect(calls[0]?.text).toBe("hi");
  });

  it("默认嗓常量与 kokoro sid 0 一致，改默认嗓即改这一处", () => {
    expect(DEFAULT_VOICE).toBe("af_maple");
  });

  it("kokoro 音色名映射到表内 sid，speed 由 wpm 换算", async () => {
    const { synth, calls } = fakeSynth();
    const { engine } = makeEngine(synth);
    await engine.speak("hi", speakOpts({ voice: "zm_100", rateWpm: 350 }));
    expect(calls[0]).toMatchObject({ sid: 102, speed: 2 });
  });

  it("matcha 音色名切到 matcha 模型并带上 vocoder 路径", async () => {
    const { synth, calls } = fakeSynth();
    const { engine } = makeEngine(synth, MATCHA_FILES);
    await engine.speak("你好", speakOpts({ voice: "zh_baker" }));
    expect(calls[0]?.spec).toEqual({ kind: "matcha", dir: MATCHA_DIR, vocoder: VOCODER });
    expect(calls[0]?.sid).toBe(0);
  });

  it("matcha 资产缺失时其音色按未登记处理，而不是构造出指向空路径的规格", async () => {
    const { engine } = makeEngine(fakeSynth().synth);
    await expect(engine.speak("你好", speakOpts({ voice: "zh_baker" }))).rejects.toBeInstanceOf(EngineError);
  });

  it("引擎内未知音色抛 EngineError，交由回退层处置而非静默落到 sid 0", async () => {
    const { engine } = makeEngine(fakeSynth().synth);
    await expect(engine.speak("hi", speakOpts({ voice: "Tingting" }))).rejects.toThrow(/Tingting/);
  });

  it("产出形态是 pcm，写盘与播放由编排层统一负责", async () => {
    const { engine } = makeEngine(fakeSynth().synth);
    const out = await engine.speak("hi", speakOpts({ output: "/tmp/x.wav" }));
    expect(out.type).toBe("pcm");
    if (out.type === "pcm") {
      expect(out.sampleRate).toBe(24000);
      expect(out.samples).toHaveLength(3);
    }
  });
});

describe("资产漂移防线：numSpeakers 与音频能量交叉校验", () => {
  it("numSpeakers 与内嵌表不符即报错，避免 sid 表错配后读出另一个嗓子", async () => {
    const { engine } = makeEngine(fakeSynth({ numSpeakers: 54 }).synth);
    await expect(engine.speak("hi", speakOpts())).rejects.toThrow(/54/);
  });

  it("全 NaN 样本被判为合成失败，不产出静音文件冒充成功", async () => {
    const { engine } = makeEngine(fakeSynth({ samples: new Float32Array([NaN, NaN, NaN]) }).synth);
    await expect(engine.speak("hi", speakOpts())).rejects.toThrow(/NaN|能量|静音/);
  });

  it("全零样本同样判失败：有长度不代表有声音", async () => {
    const { engine } = makeEngine(fakeSynth({ samples: new Float32Array(1000) }).synth);
    await expect(engine.speak("hi", speakOpts())).rejects.toBeInstanceOf(EngineError);
  });

  it("正常样本不误伤，峰值判定只看绝对值上限", async () => {
    const { engine } = makeEngine(fakeSynth({ samples: new Float32Array([0, 0, 0.001, 0]) }).synth);
    await expect(engine.speak("hi", speakOpts())).resolves.toMatchObject({ type: "pcm" });
  });
});

describe("routeEngine：音色名与显式引擎选择的仲裁", () => {
  const host = createFakeHost({
    env: { HOME: "/h" },
    files: { "/usr/bin/say": "" },
    spawnOutcome: () => ({
      exitCode: 0,
      signal: null,
      stdout: "Tingting            zh_CN    # 你好\nAlbert              en_US    # Hello\n",
      stderr: "",
    }),
  }).host;
  const sherpa = { name: "sherpa", chunkable: true } as const;
  const system = createSystemEngine(host);
  const registry = createRegistry([
    {
      ...sherpa,
      isAvailable: async () => ({ ok: true as const }),
      listVoices: async () => [],
      speak: async () => ({ type: "device" as const }),
    },
    system,
  ]);
  const config = (over: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
    engine: "sherpa",
    voice: null,
    rateWpm: 175,
    fallback: "system",
    debug: false,
    ...over,
  });

  it("显式选 system 时音色名原样下传：系统嗓语义由 say 自己兜，不替用户改主意", async () => {
    const routed = await routeEngine(config({ engine: "system", voice: "af_maple" }), registry);
    expect(routed.engine?.name).toBe("system");
    expect(routed.voice).toBe("af_maple");
  });

  it("默认引擎下 sherpa 音色名走 sherpa", async () => {
    expect((await routeEngine(config({ voice: "af_maple" }), registry)).engine?.name).toBe("sherpa");
    expect((await routeEngine(config({ voice: "zh_baker" }), registry)).engine?.name).toBe("sherpa");
  });

  it("未指定音色走配置引擎", async () => {
    expect((await routeEngine(config(), registry)).engine?.name).toBe("sherpa");
  });

  it("系统嗓开放集内的名字委派给系统嗓：用户写 -v Tingting 的意图是那个嗓子", async () => {
    const routed = await routeEngine(config({ voice: "Tingting" }), registry);
    expect(routed.engine?.name).toBe("system");
    expect(routed.voice).toBe("Tingting");
  });

  it("系统嗓清单里也没有的名字交回配置引擎，由引擎报未登记并触发回退", async () => {
    expect((await routeEngine(config({ voice: "nosuch" }), registry)).engine?.name).toBe("sherpa");
  });

  it("委派目标未登记时仍用配置引擎，由引擎自己报未知音色而不是静默换嗓", async () => {
    const onlySherpa = createRegistry([registry.get("sherpa")!]);
    expect((await routeEngine(config({ voice: "Tingting" }), onlySherpa)).engine?.name).toBe("sherpa");
  });

  it("未登记引擎返回 undefined，交由编排层给出点名报错", async () => {
    expect((await routeEngine(config({ engine: "nope" }), registry)).engine).toBeUndefined();
  });
});
