import { describe, expect, it } from "vitest";
import {
  ZIPVOICE_DIR_NAME,
  createZipvoiceEngine,
  type ZipvoiceSynth,
  type ZipvoiceSynthRequest,
} from "../src/engines/zipvoice.ts";
import { generationSpeedOf } from "../src/engines/zipvoice-binding.ts";
import { createRegistry, routeEngine } from "../src/engines/index.ts";
import { createSystemEngine } from "../src/engines/system.ts";
import { createSherpaEngine } from "../src/engines/sherpa.ts";
import { EngineError } from "../src/errors.ts";
import type { EngineAdapter, SpeakOptions } from "../src/types.ts";
import type { SpawnOutcome } from "../src/host.ts";
import { createFakeHost } from "./fake-host.ts";

const MODELS = "/cache/models";
const VOCODER = `${MODELS}/sherpa/vocoders/vocos_24khz.onnx`;
const MODEL_DIR = `${MODELS}/sherpa/${ZIPVOICE_DIR_NAME}`;
const VOICES = "/data/voices";

const MODEL_FILES = {
  [`${MODEL_DIR}/encoder.int8.onnx`]: "",
  [`${MODEL_DIR}/decoder.int8.onnx`]: "",
  [`${MODEL_DIR}/espeak-ng-data`]: "",
  [`${MODEL_DIR}/lexicon.txt`]: "",
  [`${MODEL_DIR}/tokens.txt`]: "",
  [VOCODER]: "",
};

const LUCY_META = JSON.stringify({ character: "lucy", language: "en", transcription: { source: "s" } });
const FRIEREN_META = JSON.stringify({
  character: "frieren",
  language: "ja",
  variants: { en: { language: "en" }, zh: { language: "zh" } },
});

/** 角色资产 + 模型权重全在盘的基线环境 */
function makeFiles(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...MODEL_FILES,
    [`${VOICES}/lucy/meta.json`]: LUCY_META,
    [`${VOICES}/lucy/ref.wav`]: "",
    [`${VOICES}/lucy/ref.txt`]: "lucy transcript",
    [`${VOICES}/frieren/meta.json`]: FRIEREN_META,
    [`${VOICES}/frieren/ref.wav`]: "",
    [`${VOICES}/frieren/ref.txt`]: "",
    ...extra,
  };
}

function makeEngine(
  synth: ZipvoiceSynth,
  files: Record<string, string> = makeFiles(),
): { engine: EngineAdapter; fake: ReturnType<typeof createFakeHost> } {
  const fake = createFakeHost({ env: { HOME: "/h" }, files });
  const engine = createZipvoiceEngine({ host: fake.host, modelsDir: MODELS, voicesDir: VOICES, synth });
  return { engine, fake };
}

/** 假合成器：记录请求并返回可控样本，适配器逻辑不触碰 native 绑定 */
function fakeSynth(result: Partial<Awaited<ReturnType<ZipvoiceSynth>>> = {}) {
  const calls: ZipvoiceSynthRequest[] = [];
  const synth: ZipvoiceSynth = async (req) => {
    calls.push(req);
    return { samples: result.samples ?? new Float32Array([0.1, -0.2, 0.3]), sampleRate: result.sampleRate ?? 24000 };
  };
  return { synth, calls };
}

const speakOpts = (over: Partial<SpeakOptions> = {}) => ({
  voice: "lucy",
  rateWpm: 175,
  output: null,
  ...over,
});

describe("createZipvoiceEngine.isAvailable", () => {
  it("模型权重与角色资产齐全即可用", async () => {
    const { engine } = makeEngine(fakeSynth().synth);
    expect(await engine.isAvailable("lucy")).toEqual({ ok: true });
  });

  it("模型权重缺失时不可用，一次列全缺失项", async () => {
    const files = makeFiles();
    delete files[`${MODEL_DIR}/decoder.int8.onnx`];
    const { engine } = makeEngine(fakeSynth().synth, files);
    const availability = await engine.isAvailable("lucy");
    expect(availability.ok).toBe(false);
    if (!availability.ok) {
      expect(availability.reason).toContain("decoder.int8.onnx");
      expect(availability.reason).toContain(ZIPVOICE_DIR_NAME);
    }
  });

  it("角色资产缺失时不可用，原因点名 ref 文件而不是模型目录", async () => {
    const { engine } = makeEngine(fakeSynth().synth, { ...MODEL_FILES, [`${VOICES}/lucy/meta.json`]: LUCY_META });
    const availability = await engine.isAvailable("lucy");
    expect(availability.ok).toBe(false);
    if (!availability.ok) expect(availability.reason).toContain("ref.wav");
  });

  it("默认嗓与角色无关，不在本引擎判死", async () => {
    const { engine } = makeEngine(fakeSynth().synth);
    expect((await engine.isAvailable(null)).ok).toBe(true);
  });
});

describe("createZipvoiceEngine.speak：角色资产到克隆参数", () => {
  it("角色名解析出参考音频与转写，speed 由 wpm 换算，加速请求被警告忽略", async () => {
    const { synth, calls } = fakeSynth();
    const { engine, fake } = makeEngine(synth);
    await engine.speak("hi", speakOpts({ rateWpm: 350 }));
    expect(calls[0]).toMatchObject({
      referenceAudioPath: `${VOICES}/lucy/ref.wav`,
      referenceText: "lucy transcript",
      speed: 2,
    });
    expect(calls[0]?.spec.dir).toBe(MODEL_DIR);
    expect(calls[0]?.spec.vocoder).toBe(VOCODER);
    expect(fake.stderr.join("")).toContain("加速");
  });

  it("产出形态是 pcm，写盘与播放由编排层统一负责", async () => {
    const { engine } = makeEngine(fakeSynth().synth);
    const out = await engine.speak("hi", speakOpts());
    expect(out.type).toBe("pcm");
    if (out.type === "pcm") expect(out.sampleRate).toBe(24000);
  });

  it("未给角色音色时报引擎错误：克隆嗓没有默认嗓可言", async () => {
    const { engine } = makeEngine(fakeSynth().synth);
    await expect(engine.speak("hi", speakOpts({ voice: null }))).rejects.toThrow(/角色音色/);
  });

  it("非角色音色报精确的未登记原因，交给回退层", async () => {
    const { engine } = makeEngine(fakeSynth().synth);
    await expect(engine.speak("hi", speakOpts({ voice: "Tingting" }))).rejects.toThrow(/Tingting/);
  });

  it("全 NaN 样本判合成失败，不产出静音文件冒充成功", async () => {
    const { engine } = makeEngine(fakeSynth({ samples: new Float32Array([NaN, NaN]) }).synth);
    await expect(engine.speak("hi", speakOpts())).rejects.toBeInstanceOf(EngineError);
  });

  it("全零样本同样判失败", async () => {
    const { engine } = makeEngine(fakeSynth({ samples: new Float32Array(10) }).synth);
    await expect(engine.speak("hi", speakOpts())).rejects.toBeInstanceOf(EngineError);
  });
});

describe("createZipvoiceEngine.listVoices 与 ownsVoice", () => {
  it("扫描角色目录列举主嗓与语言变体，日配嗓按多语记", async () => {
    const { engine } = makeEngine(fakeSynth().synth);
    const voices = await engine.listVoices();
    expect(voices).toContainEqual({ name: "lucy", engine: "zipvoice", lang: "en" });
    expect(voices).toContainEqual({ name: "frieren", engine: "zipvoice", lang: "multi" });
    expect(voices).toContainEqual({ name: "frieren-en", engine: "zipvoice", lang: "en" });
    expect(voices).toContainEqual({ name: "frieren-zh", engine: "zipvoice", lang: "zh" });
  });

  it("角色目录在盘即认领该名字（含变体拼写），资产是否完整留给可用性层", () => {
    const { engine } = makeEngine(fakeSynth().synth, makeFiles({ [`${VOICES}/lucy/ref.wav`]: "" }));
    expect(engine.ownsVoice?.("lucy")).toBe(true);
    expect(engine.ownsVoice?.("frieren-en")).toBe(true);
    expect(engine.ownsVoice?.("nosuch")).toBe(false);
    expect(engine.ownsVoice?.("af_maple")).toBe(false);
  });
});

describe("generationSpeedOf：克隆链路语速安全域", () => {
  it("放慢请求原样放行，等于 1 与加速请求一律不下发", () => {
    expect(generationSpeedOf(0.8)).toBe(0.8);
    expect(generationSpeedOf(0.5)).toBe(0.5);
    expect(generationSpeedOf(1)).toBeNull();
    expect(generationSpeedOf(2)).toBeNull();
    expect(generationSpeedOf(0)).toBeNull();
  });
});

describe("routeEngine：角色嗓加入后的三分仲裁", () => {
  const voiceList = (): SpawnOutcome => ({
    exitCode: 0,
    signal: null,
    stdout: "Tingting            zh_CN    # 你好\nAlbert              en_US    # Hello\n",
    stderr: "",
  });
  const systemHost = createFakeHost({
    env: { HOME: "/h" },
    files: {
      "/usr/bin/say": "",
      [`${VOICES}/lucy/meta.json`]: LUCY_META,
      [`${VOICES}/frieren/meta.json`]: FRIEREN_META,
    },
    spawnOutcome: voiceList,
  }).host;
  const sherpaSynth = () => Promise.resolve({ samples: new Float32Array([0.1]), sampleRate: 24000, numSpeakers: 103 });
  const sherpa = createSherpaEngine({ host: systemHost, modelsDir: MODELS, synth: sherpaSynth });
  const zipvoice = createZipvoiceEngine({
    host: systemHost,
    modelsDir: MODELS,
    voicesDir: VOICES,
    synth: fakeSynth().synth,
  });
  const system = createSystemEngine(systemHost);
  const registry = createRegistry([sherpa, zipvoice, system]);
  const config = (over: Partial<Parameters<typeof routeEngine>[0]> = {}) => ({
    engine: "sherpa",
    voice: null,
    rateWpm: 175,
    fallback: "system" as const,
    debug: false,
    ...over,
  });

  it("角色音色路由到 zipvoice，即便配置引擎是 sherpa", async () => {
    const routed = await routeEngine(config({ voice: "lucy" }), registry);
    expect(routed.engine?.name).toBe("zipvoice");
    expect(routed.voice).toBe("lucy");
  });

  it("sherpa 音色仍走 sherpa", async () => {
    expect((await routeEngine(config({ voice: "af_maple" }), registry)).engine?.name).toBe("sherpa");
  });

  it("系统嗓开放集仍委派系统引擎，Tingting 不被角色目录劫持", async () => {
    const routed = await routeEngine(config({ voice: "Tingting" }), registry);
    expect(routed.engine?.name).toBe("system");
  });

  it("谁也不认领的名字交给配置引擎，由其报未登记并触发回退", async () => {
    const routed = await routeEngine(config({ voice: "nosuch" }), registry);
    expect(routed.engine?.name).toBe("sherpa");
  });

  it("显式点名 zipvoice 时角色音色走 zipvoice", async () => {
    const routed = await routeEngine(config({ engine: "zipvoice", voice: "frieren-zh" }), registry);
    expect(routed.engine?.name).toBe("zipvoice");
  });

  it("显式点名 system 时音色名原样下传：系统嗓语义由 say 自己兜，不替用户改主意", async () => {
    const routed = await routeEngine(config({ engine: "system", voice: "af_maple" }), registry);
    expect(routed.engine?.name).toBe("system");
  });
});