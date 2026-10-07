import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import {
  INDEXTTS_ENGINE,
  createIndexttsEngine,
  indexttsMissingAssets,
  resolveLabPython,
} from "../src/engines/indextts.ts";
import { createShimSynth, type IndexttsSynthRequest } from "../src/engines/indextts-binding.ts";
import { createRegistry, createDefaultRegistry, routeEngine } from "../src/engines/index.ts";
import { createSystemEngine } from "../src/engines/system.ts";
import { EngineError } from "../src/errors.ts";
import type { EngineAdapter, SpeakOptions } from "../src/types.ts";
import type { FakeDaemonHandle } from "./fake-host.ts";
import { createFakeHost } from "./fake-host.ts";

const LAB = "/lab/indextts";
const REPO = `${LAB}/index-tts`;
const CHECKPOINTS = `${LAB}/checkpoints`;
const VOICES = "/data/voices";
const SHIM = "/say-repo/scripts/shims/indextts-shim.py";

const FRIEREN_META = JSON.stringify({
  character: "frieren",
  language: "ja",
  variants: { en: { language: "en" }, zh: { language: "zh" } },
});

/** 安装面判据基线（venv + 仓库内核 + checkpoints 九件 + default 参考音频，indexttsMissingAssets 的清单）在盘的环境 */
function makeFiles(extra: Record<string, string> = {}): Record<string, string> {
  return {
    [`${REPO}/.venv/bin/python`]: "",
    [`${REPO}/indextts/infer_v2_5.py`]: "",
    [`${CHECKPOINTS}/gpt.pth`]: "",
    [`${CHECKPOINTS}/codec.pth`]: "",
    [`${CHECKPOINTS}/s2mel.pth`]: "",
    [`${CHECKPOINTS}/qwen0.6bemo4-merge/model.safetensors`]: "",
    [`${CHECKPOINTS}/config.yaml`]: "",
    [`${CHECKPOINTS}/feat1.pt`]: "",
    [`${CHECKPOINTS}/feat2.pt`]: "",
    [`${CHECKPOINTS}/wav2vec2bert_stats.pt`]: "",
    [`${CHECKPOINTS}/multilingual_zh_ja_yue_char_del.tiktoken`]: "",
    [`${REPO}/examples/voice_01.wav`]: "",
    [`${VOICES}/frieren/meta.json`]: FRIEREN_META,
    [`${VOICES}/frieren/ref.wav`]: "",
    [`${VOICES}/frieren/ref.txt`]: "frieren transcript line\n# 转写来源: some-provenance\n",
    [`${VOICES}/frieren/ref-en.wav`]: "",
    [`${VOICES}/frieren/ref-en.txt`]: "frieren en transcript line\n",
    ...extra,
  };
}

/** 假整句合成器：记录请求并按脚本产出（或抛错） */
function fakeSynth(script: (req: IndexttsSynthRequest) => { samples?: number[]; sampleRate?: number } | null) {
  const calls: IndexttsSynthRequest[] = [];
  const synth = async (req: IndexttsSynthRequest) => {
    calls.push(req);
    const step = script(req);
    if (step === null) throw new EngineError("整句合成炸了");
    return { samples: new Float32Array(step.samples ?? [0.1, -0.2]), sampleRate: step.sampleRate ?? 22050 };
  };
  return { synth, calls };
}

const speakOpts = (over: Partial<SpeakOptions> = {}): SpeakOptions => ({
  voice: null,
  rateWpm: 175,
  output: null,
  ...over,
});

function makeEngine(
  synth: (req: IndexttsSynthRequest) => Promise<{ samples: Float32Array; sampleRate: number }>,
  files: Record<string, string> = makeFiles(),
): { engine: EngineAdapter; fake: ReturnType<typeof createFakeHost> } {
  const fake = createFakeHost({ env: { HOME: "/h" }, files });
  const engine = createIndexttsEngine({
    host: fake.host,
    labDir: LAB,
    voicesDir: VOICES,
    shimPath: SHIM,
    synth: synth as never,
  });
  return { engine, fake };
}

describe("indextts 安装面判据", () => {
  it("判据清单齐全时 missing 为空", () => {
    const fake = createFakeHost({ env: { HOME: "/h" }, files: makeFiles() });
    const missing = indexttsMissingAssets(
      { labDir: LAB, repoDir: REPO, modelsDir: CHECKPOINTS, pythonPath: `${REPO}/.venv/bin/python`, shimPath: SHIM },
      fake.host,
    );
    expect(missing).toEqual([]);
  });

  it("缺任一权重文件按缺项报，原因点名安装脚本", async () => {
    const files = makeFiles();
    delete files[`${CHECKPOINTS}/s2mel.pth`];
    const { engine } = makeEngine(fakeSynth(() => null).synth, files);
    const availability = await engine.isAvailable(null);
    expect(availability.ok).toBe(false);
    if (!availability.ok) {
      expect(availability.reason).toContain("s2mel.pth");
      expect(availability.reason).toContain("install-engine.mjs indextts");
    }
  });

  it("缺项计数是缺失文件数而非文案字符数（复制链同型缺陷回归锚）", async () => {
    const files = makeFiles();
    delete files[`${CHECKPOINTS}/s2mel.pth`];
    delete files[`${CHECKPOINTS}/codec.pth`];
    const { engine } = makeEngine(fakeSynth(() => null).synth, files);
    const availability = await engine.isAvailable(null);
    expect(availability.ok).toBe(false);
    if (!availability.ok) expect(availability.reason).toContain("缺少 2 项");
  });

  it("resolveLabPython 认三形态 venv（与 engine-status 同构；uv sync 落仓库内 .venv）", () => {
    const expectPython = (files: Record<string, string>): string =>
      resolveLabPython(LAB, createFakeHost({ env: { HOME: "/h" }, files }).host);
    expect(expectPython(makeFiles())).toBe(`${REPO}/.venv/bin/python`);
    const stdVenv = makeFiles();
    stdVenv[`${LAB}/venv/bin/python`] = "";
    expect(expectPython(stdVenv)).toBe(`${LAB}/venv/bin/python`);
    const dotVenv = makeFiles();
    delete dotVenv[`${REPO}/.venv/bin/python`];
    dotVenv[`${LAB}/.venv/bin/python`] = "";
    expect(expectPython(dotVenv)).toBe(`${LAB}/.venv/bin/python`);
  });

  it("default 嗓依赖引擎仓自带示例音频，缺失判不可用并点名文件", async () => {
    const files = makeFiles();
    delete files[`${REPO}/examples/voice_01.wav`];
    const { engine } = makeEngine(fakeSynth(() => null).synth, files);
    const availability = await engine.isAvailable("default");
    expect(availability.ok).toBe(false);
    if (!availability.ok) expect(availability.reason).toContain("voice_01.wav");
  });

  it("角色资产缺失时不可用，原因点名 ref 文件", async () => {
    const files = makeFiles();
    delete files[`${VOICES}/frieren/ref.wav`];
    const { engine } = makeEngine(fakeSynth(() => null).synth, files);
    const availability = await engine.isAvailable("frieren");
    expect(availability.ok).toBe(false);
    if (!availability.ok) expect(availability.reason).toContain("ref.wav");
  });
});

describe("indextts.speak（注入假合成器）", () => {
  it("default 嗓参考指向引擎仓自带示例", async () => {
    const { synth, calls } = fakeSynth(() => ({ samples: [0.1] }));
    const { engine } = makeEngine(synth);
    const out = await engine.speak("你好世界", speakOpts());
    expect(calls[0]!.refAudioPath).toBe(`${REPO}/examples/voice_01.wav`);
    expect(out).toEqual({ type: "pcm", samples: new Float32Array([0.1]), sampleRate: 22050 });
  });

  it("角色嗓：ref.wav 一比一映射（转写不进协议，IndexTTS 无 prompt_text 参数）", async () => {
    const { synth, calls } = fakeSynth(() => ({ samples: [0.3] }));
    const { engine } = makeEngine(synth);
    await engine.speak("こんにちは", speakOpts({ voice: "frieren" }));
    expect(calls[0]!.refAudioPath).toBe(`${VOICES}/frieren/ref.wav`);
  });

  it("文本语言自判进 textLang：中文判 zh、英文判 en（default 参考共用，lang 独立控制发音）", async () => {
    const { synth, calls } = fakeSynth(() => ({ samples: [0.1] }));
    const { engine } = makeEngine(synth);
    await engine.speak("你好世界", speakOpts());
    await engine.speak("hello world", speakOpts());
    expect(calls[0]!.textLang).toBe("zh");
    expect(calls[1]!.textLang).toBe("en");
  });

  it("语速映射为时长倍率互为倒数：175wpm→1.0、350wpm→0.5、87.5wpm→2.0", async () => {
    const { synth, calls } = fakeSynth(() => ({ samples: [0.1] }));
    const { engine } = makeEngine(synth);
    await engine.speak("一", speakOpts({ rateWpm: 175 }));
    await engine.speak("一", speakOpts({ rateWpm: 350 }));
    await engine.speak("一", speakOpts({ rateWpm: 87.5 }));
    expect(calls[0]!.durationFactor).toBeCloseTo(1.0, 10);
    expect(calls[1]!.durationFactor).toBeCloseTo(0.5, 10);
    expect(calls[2]!.durationFactor).toBeCloseTo(2.0, 10);
  });

  it("语速超界按 wpmToSpeed 的 clamp 域取倒数（35wpm 慢到顶 → 2.0）", async () => {
    const { synth, calls } = fakeSynth(() => ({ samples: [0.1] }));
    const { engine } = makeEngine(synth);
    await engine.speak("一", speakOpts({ rateWpm: 35 }));
    expect(calls[0]!.durationFactor).toBeCloseTo(2.0, 10);
  });

  it("emoAlpha 一期不发送（协议预留位，adapter 不传）", async () => {
    const { synth, calls } = fakeSynth(() => ({ samples: [0.1] }));
    const { engine } = makeEngine(synth);
    await engine.speak("你好", speakOpts());
    expect(calls[0]!.emoAlpha).toBeUndefined();
  });

  it("空产出不交付：能量校验失败抛 EngineError 交回退层", async () => {
    const { engine } = makeEngine(fakeSynth(() => ({ samples: [] })).synth);
    await expect(engine.speak("你好", speakOpts())).rejects.toThrow(/空样本/);
  });

  it("未登记的角色名报精确原因（点 voicesDir）", async () => {
    const { engine } = makeEngine(fakeSynth(() => null).synth);
    await expect(engine.speak("hi", speakOpts({ voice: "nosuch" }))).rejects.toThrow(/nosuch/);
  });
});

describe("indextts 注册表接线", () => {
  it("ownsVoice 认领在盘角色，default 不认领（不劫持路由仲裁）", () => {
    const { engine } = makeEngine(fakeSynth(() => null).synth);
    expect(engine.ownsVoice?.("frieren")).toBe(true);
    expect(engine.ownsVoice?.("frieren-zh")).toBe(true);
    expect(engine.ownsVoice?.("default")).toBe(false);
    expect(engine.ownsVoice?.("nosuch")).toBe(false);
  });

  it("listVoices 含 default 关键字与角色（含语言变体）", async () => {
    const { engine } = makeEngine(fakeSynth(() => null).synth);
    const voices = await engine.listVoices();
    const names = voices.map((v) => v.name);
    expect(names).toContain("default");
    expect(names).toContain("frieren");
    expect(names).toContain("frieren-en");
    expect(voices.every((v) => v.engine === INDEXTTS_ENGINE)).toBe(true);
  });

  it("engine=indextts 时路由命中适配器；显式 -e indextts 压过共享角色目录的登记序", async () => {
    const fake = createFakeHost({ env: { HOME: "/h" }, files: makeFiles() });
    const registry = createRegistry([makeEngine(fakeSynth(() => null).synth).engine, createSystemEngine(fake.host, "/usr/bin/say")]);
    const config = { engine: INDEXTTS_ENGINE, voice: null, rateWpm: 175, fallback: "system" as const, debug: false };
    const routed = await routeEngine(config, registry);
    expect(routed.engine?.name).toBe(INDEXTTS_ENGINE);
    const byVoice = await routeEngine({ ...config, voice: "frieren" }, registry);
    expect(byVoice.engine?.name).toBe(INDEXTTS_ENGINE);
    expect(byVoice.voice).toBe("frieren");
  });

  it("createDefaultRegistry 登记即接线：engine 名可查", () => {
    const fake = createFakeHost({ env: { HOME: "/h" }, files: makeFiles() });
    const registry = createDefaultRegistry(fake.host);
    expect(registry.names()).toContain(INDEXTTS_ENGINE);
  });
});

/** 驱动假 shim 行为的工厂：startup 写就绪/致命帧，onRequest 按请求行回写响应帧序列 */
interface ShimBehavior {
  startup?: (output: PassThrough, errors: PassThrough) => void;
  onRequest?: (line: string, handle: FakeDaemonHandle) => void;
}

function makeShimEngine(behavior: ShimBehavior): { engine: EngineAdapter; fake: ReturnType<typeof createFakeHost> } {
  const fake = createFakeHost({
    env: { HOME: "/h" },
    files: makeFiles(),
    daemonFactory: () => {
      const output = new PassThrough();
      const errors = new PassThrough();
      behavior.startup?.(output, errors);
      return {
        output,
        errors,
        onRequest: (line, handle) => behavior.onRequest?.(line, handle),
      };
    },
  });
  const engine = createIndexttsEngine({
    host: fake.host,
    labDir: LAB,
    voicesDir: VOICES,
    shimPath: SHIM,
    synth: createShimSynth(
      { labDir: LAB, repoDir: REPO, modelsDir: CHECKPOINTS, pythonPath: "/usr/bin/env", shimPath: SHIM },
      fake.host,
    ),
  });
  return { engine, fake };
}

function handleOf(fake: ReturnType<typeof createFakeHost>): FakeDaemonHandle {
  const handle = fake.daemonHandles[0];
  if (handle === undefined) throw new Error("daemon 未拉起");
  return handle;
}

function writeAudio(handle: FakeDaemonHandle, id: number, samples: readonly number[], done: boolean, sampleRate = 22050): void {
  const bytes = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => bytes.writeInt16LE(Math.round(s * 32768), i * 2));
  handle.output.write(`${JSON.stringify({ type: "audio", id, pcm: bytes.toString("base64"), sample_rate: sampleRate, done })}\n`);
}

const quantized = (v: number): number => Math.round(v * 32768) / 32768;

describe("indextts shim 会话（fake daemon 驱动整句协议）", () => {
  it("ready 握手后整句合成：请求行带 ref_audio_path 与 duration_factor，单帧 done 交付", async () => {
    const { engine, fake } = makeShimEngine({
      startup: (output) => output.write('{"type":"ready","engine":"indextts","version":"2.5","device":"mps"}\n'),
      onRequest: (line, handle) => {
        const req = JSON.parse(line) as { id: number };
        writeAudio(handle, req.id, [0.5, -0.5], true);
      },
    });
    const out = await engine.speak("你好", speakOpts());
    expect(out.type).toBe("pcm");
    if (out.type === "pcm") expect([...out.samples]).toEqual([quantized(0.5), quantized(-0.5)]);
    const request = JSON.parse(handleOf(fake).requests[0]!) as Record<string, unknown>;
    expect(request.type).toBe("synthesize");
    expect(request.ref_audio_path).toBe(`${REPO}/examples/voice_01.wav`);
    expect(request.text_lang).toBe("zh");
    expect(request.duration_factor).toBeCloseTo(1.0, 10);
    expect(request.emo_alpha).toBeUndefined();
  });

  it("spawn 参数携带 --repo 与 --models（shim 定位仓库与 checkpoints）", async () => {
    const { engine, fake } = makeShimEngine({
      startup: (output) => output.write('{"type":"ready","engine":"indextts","version":"2.5","device":"mps"}\n'),
      onRequest: (line, handle) => {
        const req = JSON.parse(line) as { id: number };
        writeAudio(handle, req.id, [0.5], true);
      },
    });
    await engine.speak("你好", speakOpts());
    const record = fake.daemons[0];
    expect(record?.args).toEqual([SHIM, "--repo", REPO, "--models", CHECKPOINTS]);
  });

  it("stdout 先于 exit 终止：按输出终止快速收敛而非空转（EOF-exit 空窗回归锚）", async () => {
    const { engine } = makeShimEngine({
      startup: (output) => output.write('{"type":"ready","engine":"indextts","version":"2.5","device":"mps"}\n'),
      onRequest: (line, handle) => {
        const req = JSON.parse(line) as { id: number };
        writeAudio(handle, req.id, [0.5], false);
        // 流先关、exit 300ms 后才 settle：真机 SIGKILL 后 EOF 与 exit 事件空窗的放大形态
        handle.output.end();
        setTimeout(() => handle.die("SIGKILL"), 300).unref();
      },
    });
    const started = Date.now();
    await expect(engine.speak("你好", speakOpts())).rejects.toThrow(/输出已终止/);
    // 快速收敛 = 没在空窗里空转（修前形态：每圈一个 deadline 定时器，毫秒级烧穿堆）
    expect(Date.now() - started).toBeLessThan(300);
  });

  it("中途进程死亡：EngineError 而非悬挂", async () => {
    const { engine } = makeShimEngine({
      startup: (output) => output.write('{"type":"ready","engine":"indextts","version":"2.5","device":"mps"}\n'),
      onRequest: (_line, handle) => {
        setTimeout(() => handle.die("SIGKILL"), 20).unref();
      },
    });
    await expect(engine.speak("你好", speakOpts())).rejects.toBeInstanceOf(EngineError);
  });

  it("error 帧：EngineError 携带 shim 报的原因", async () => {
    const { engine } = makeShimEngine({
      startup: (output) => output.write('{"type":"ready","engine":"indextts","version":"2.5","device":"mps"}\n'),
      onRequest: (line, handle) => {
        const req = JSON.parse(line) as { id: number };
        handle.output.write(`${JSON.stringify({ type: "error", id: req.id, message: "ref_audio_path 不存在" })}\n`);
      },
    });
    await expect(engine.speak("你好", speakOpts())).rejects.toThrow(/ref_audio_path 不存在/);
  });

  it("加载期 fatal：EngineError 携带 shim 报的原因", async () => {
    const { engine } = makeShimEngine({
      startup: (output) => output.write('{"type":"fatal","message":"config.yaml 损坏"}\n'),
    });
    await expect(engine.speak("你好", speakOpts())).rejects.toThrow(/config.yaml 损坏/);
  });

  it("同引擎实例多次合成复用同一进程；第二请求等第一合成完才发（互斥链）", async () => {
    const timings: string[] = [];
    const { engine, fake } = makeShimEngine({
      startup: (output) => output.write('{"type":"ready","engine":"indextts","version":"2.5","device":"mps"}\n'),
      onRequest: (line, handle) => {
        const req = JSON.parse(line) as { id: number; text: string };
        timings.push(`start:${req.text}`);
        setTimeout(() => {
          writeAudio(handle, req.id, [0.1], true);
          timings.push(`end:${req.text}`);
        }, 10).unref();
      },
    });
    await engine.speak("第一句", speakOpts());
    await engine.speak("第二句", speakOpts());
    expect(fake.daemons).toHaveLength(1);
    // 互斥：第二句的请求行必须落在第一句 end 之后
    expect(timings.indexOf("start:第二句")).toBeGreaterThan(timings.indexOf("end:第一句"));
  });

  it("spawn 本身失败（解释器不存在）按加载期退出收敛", async () => {
    const fake = createFakeHost({
      env: { HOME: "/h" },
      files: makeFiles(),
      daemonFactory: () => null,
    });
    const engine = createIndexttsEngine({
      host: fake.host,
      labDir: LAB,
      voicesDir: VOICES,
      shimPath: SHIM,
      synth: createShimSynth(
        { labDir: LAB, repoDir: REPO, modelsDir: CHECKPOINTS, pythonPath: "/nonexistent/python", shimPath: SHIM },
        fake.host,
      ),
    });
    await expect(engine.speak("你好", speakOpts())).rejects.toThrow(/IndexTTS/);
  });
});
