import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import {
  FIRERED_ENGINE,
  createFireredEngine,
  fireredMissingAssets,
  resolveLabPython,
} from "../src/engines/firered.ts";
import { createShimSynth, fireredDevice, type FireredSynthRequest } from "../src/engines/firered-binding.ts";
import { createRegistry, createDefaultRegistry, routeEngine } from "../src/engines/index.ts";
import { createSystemEngine } from "../src/engines/system.ts";
import { EngineError } from "../src/errors.ts";
import type { EngineAdapter, SpeakOptions } from "../src/types.ts";
import type { FakeDaemonHandle } from "./fake-host.ts";
import { createFakeHost } from "./fake-host.ts";

const LAB = "/lab/firered";
const REPO = `${LAB}/FireRedTTS3`;
const MODELS = `${LAB}/models/FireRedTTS3`;
const VOICES = "/data/voices";
const SHIM = "/say-repo/scripts/shims/firered-shim.py";
const DEFAULT_REF = `${LAB}/prompts/prompt_2.wav`;

const FRIEREN_META = JSON.stringify({
  character: "frieren",
  language: "ja",
  variants: { en: { language: "en" }, zh: { language: "zh" } },
});

/** 安装面判据基线（venv + 仓库内核 + weights 十件 + default 参考）在盘的环境 */
function makeFiles(extra: Record<string, string> = {}): Record<string, string> {
  return {
    [`${LAB}/venv/bin/python`]: "",
    [`${REPO}/fireredtts3/core.py`]: "",
    [`${MODELS}/fireredtts3_base/model.safetensors`]: "",
    [`${MODELS}/fireredtts3_base/config.json`]: "",
    [`${MODELS}/fireredtts3_instruct/model.safetensors`]: "",
    [`${MODELS}/fireredtts3_instruct/config.json`]: "",
    [`${MODELS}/redae/model.safetensors`]: "",
    [`${MODELS}/redae/config.json`]: "",
    [`${MODELS}/campp/campplus_voxceleb.bin`]: "",
    [`${MODELS}/text_tokenizer/tokenizer.json`]: "",
    [`${MODELS}/text_tokenizer/tokenizer_config.json`]: "",
    [`${MODELS}/text_tokenizer/vocab.json`]: "",
    [DEFAULT_REF]: "",
    [`${VOICES}/frieren/meta.json`]: FRIEREN_META,
    [`${VOICES}/frieren/ref.wav`]: "",
    [`${VOICES}/frieren/ref.txt`]: "frieren transcript line\n# 转写来源: some-provenance\n",
    [`${VOICES}/frieren/ref-en.wav`]: "",
    [`${VOICES}/frieren/ref-en.txt`]: "frieren en transcript line\n",
    ...extra,
  };
}

/** 假整句合成器：记录请求并按脚本产出（或抛错） */
function fakeSynth(script: (req: FireredSynthRequest) => { samples?: number[]; sampleRate?: number } | null) {
  const calls: FireredSynthRequest[] = [];
  const synth = async (req: FireredSynthRequest) => {
    calls.push(req);
    const step = script(req);
    if (step === null) throw new EngineError("整句合成炸了");
    return { samples: new Float32Array(step.samples ?? [0.1, -0.2]), sampleRate: step.sampleRate ?? 24000 };
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
  synth: (req: FireredSynthRequest) => Promise<{ samples: Float32Array; sampleRate: number }>,
  files: Record<string, string> = makeFiles(),
): { engine: EngineAdapter; fake: ReturnType<typeof createFakeHost> } {
  const fake = createFakeHost({ env: { HOME: "/h" }, files });
  const engine = createFireredEngine({
    host: fake.host,
    labDir: LAB,
    voicesDir: VOICES,
    shimPath: SHIM,
    synth: synth as never,
  });
  return { engine, fake };
}

describe("firered 安装面判据", () => {
  it("判据清单齐全时 missing 为空", () => {
    const fake = createFakeHost({ env: { HOME: "/h" }, files: makeFiles() });
    const missing = fireredMissingAssets(
      { labDir: LAB, repoDir: REPO, modelsDir: MODELS, pythonPath: `${LAB}/venv/bin/python`, shimPath: SHIM },
      fake.host,
    );
    expect(missing).toEqual([]);
  });

  it("缺任一权重文件按缺项报，原因点名安装脚本", async () => {
    const files = makeFiles();
    delete files[`${MODELS}/redae/model.safetensors`];
    const { engine } = makeEngine(fakeSynth(() => null).synth, files);
    const availability = await engine.isAvailable(null);
    expect(availability.ok).toBe(false);
    if (!availability.ok) {
      expect(availability.reason).toContain("redae/model.safetensors");
      expect(availability.reason).toContain("install-engine.mjs firered");
    }
  });

  it("缺项计数是缺失文件数而非文案字符数（复制链同型缺陷回归锚）", async () => {
    const files = makeFiles();
    delete files[`${MODELS}/redae/model.safetensors`];
    delete files[DEFAULT_REF];
    const { engine } = makeEngine(fakeSynth(() => null).synth, files);
    const availability = await engine.isAvailable(null);
    expect(availability.ok).toBe(false);
    if (!availability.ok) expect(availability.reason).toContain("缺少 2 项");
  });

  it("resolveLabPython 认三形态 venv（与 engine-status 同构；uv venv 落 labDir/venv）", () => {
    const expectPython = (files: Record<string, string>): string =>
      resolveLabPython(LAB, createFakeHost({ env: { HOME: "/h" }, files }).host);
    expect(expectPython(makeFiles())).toBe(`${LAB}/venv/bin/python`);
    const dotVenv = makeFiles();
    delete dotVenv[`${LAB}/venv/bin/python`];
    dotVenv[`${LAB}/.venv/bin/python`] = "";
    expect(expectPython(dotVenv)).toBe(`${LAB}/.venv/bin/python`);
    const repoVenv = makeFiles();
    delete repoVenv[`${LAB}/venv/bin/python`];
    repoVenv[`${REPO}/.venv/bin/python`] = "";
    expect(expectPython(repoVenv)).toBe(`${REPO}/.venv/bin/python`);
  });

  it("default 嗓依赖 manifest 分发的官方参考，缺失判不可用并点名文件", async () => {
    const files = makeFiles();
    delete files[DEFAULT_REF];
    const { engine } = makeEngine(fakeSynth(() => null).synth, files);
    const availability = await engine.isAvailable("default");
    expect(availability.ok).toBe(false);
    if (!availability.ok) expect(availability.reason).toContain("prompt_2.wav");
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

describe("firered.speak（注入假合成器）", () => {
  it("default 嗓参考指向 manifest 分发的官方 prompt，转写为钉死常量", async () => {
    const { synth, calls } = fakeSynth(() => ({ samples: [0.1] }));
    const { engine } = makeEngine(synth);
    const out = await engine.speak("你好世界", speakOpts());
    expect(calls[0]!.refAudioPath).toBe(DEFAULT_REF);
    expect(calls[0]!.promptText).toBe("对，所以说你现在的话，这个账单的话，你既然说能处理，那你就想办法处理掉。");
    expect(out).toEqual({ type: "pcm", samples: new Float32Array([0.1]), sampleRate: 24000 });
  });

  it("角色嗓：ref.wav 一比一映射，ref.txt 剥溯源注释后进 promptText（FireRed 克隆必带转写）", async () => {
    const { synth, calls } = fakeSynth(() => ({ samples: [0.3] }));
    const { engine } = makeEngine(synth);
    await engine.speak("こんにちは", speakOpts({ voice: "frieren" }));
    expect(calls[0]!.refAudioPath).toBe(`${VOICES}/frieren/ref.wav`);
    expect(calls[0]!.promptText).toBe("frieren transcript line");
  });

  it("文本语言自判进 textLang：中文判 zh、英文判 en（shim 内映射白名单 tag）", async () => {
    const { synth, calls } = fakeSynth(() => ({ samples: [0.1] }));
    const { engine } = makeEngine(synth);
    await engine.speak("你好世界", speakOpts());
    await engine.speak("hello world", speakOpts());
    expect(calls[0]!.textLang).toBe("zh");
    expect(calls[1]!.textLang).toBe("en");
  });

  it("语速不透出（Base.generate 无语速参数，rateWpm 忽略）", async () => {
    const { synth, calls } = fakeSynth(() => ({ samples: [0.1] }));
    const { engine } = makeEngine(synth);
    await engine.speak("你好", speakOpts({ rateWpm: 300 }));
    expect(calls[0]).not.toHaveProperty("durationFactor");
    expect(calls[0]).not.toHaveProperty("speedFactor");
  });

  it("空产出不交付：能量校验失败抛 EngineError 交回退层", async () => {
    const { engine } = makeEngine(fakeSynth(() => ({ samples: [] })).synth);
    await expect(engine.speak("你好", speakOpts())).rejects.toThrow(/空样本/);
  });

  it("未登记的角色名报精确原因（点 voicesDir）", async () => {
    const { engine } = makeEngine(fakeSynth(() => null).synth);
    await expect(engine.speak("hi", speakOpts({ voice: "nosuch" }))).rejects.toThrow(/nosuch/);
  });

  it("同一角色的 isAvailable 与 speak 只解析一次 meta.json（实例内 memo 收敛，S3 审查 F5/P2 回归锚）", async () => {
    const fake = createFakeHost({ env: { HOME: "/h" }, files: makeFiles() });
    const reads: string[] = [];
    const host = {
      ...fake.host,
      readFileText: async (path: string) => {
        reads.push(path);
        return fake.host.readFileText(path);
      },
    };
    const { synth } = fakeSynth(() => ({ samples: [0.1] }));
    const engine = createFireredEngine({
      host,
      labDir: LAB,
      voicesDir: VOICES,
      shimPath: SHIM,
      synth: synth as never,
    });
    await engine.isAvailable("frieren");
    await engine.speak("你好", speakOpts({ voice: "frieren" }));
    const metaReads = reads.filter((path) => path.endsWith("meta.json"));
    expect(metaReads).toHaveLength(1);
  });
});

describe("firered 注册表接线", () => {
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
    expect(voices.every((v) => v.engine === FIRERED_ENGINE)).toBe(true);
  });

  it("engine=firered 时路由命中适配器；显式 -e firered 压过共享角色目录的登记序", async () => {
    const fake = createFakeHost({ env: { HOME: "/h" }, files: makeFiles() });
    const registry = createRegistry([makeEngine(fakeSynth(() => null).synth).engine, createSystemEngine(fake.host, "/usr/bin/say")]);
    const config = { engine: FIRERED_ENGINE, voice: null, rateWpm: 175, fallback: "system" as const, debug: false };
    const routed = await routeEngine(config, registry);
    expect(routed.engine?.name).toBe(FIRERED_ENGINE);
    const byVoice = await routeEngine({ ...config, voice: "frieren" }, registry);
    expect(byVoice.engine?.name).toBe(FIRERED_ENGINE);
    expect(byVoice.voice).toBe("frieren");
  });

  it("createDefaultRegistry 登记即接线：engine 名可查", () => {
    const fake = createFakeHost({ env: { HOME: "/h" }, files: makeFiles() });
    const registry = createDefaultRegistry(fake.host);
    expect(registry.names()).toContain(FIRERED_ENGINE);
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
  const engine = createFireredEngine({
    host: fake.host,
    labDir: LAB,
    voicesDir: VOICES,
    shimPath: SHIM,
    synth: createShimSynth(
      { labDir: LAB, repoDir: REPO, modelsDir: MODELS, pythonPath: "/usr/bin/env", shimPath: SHIM },
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

function writeAudio(handle: FakeDaemonHandle, id: number, samples: readonly number[], done: boolean, sampleRate = 24000): void {
  const bytes = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => bytes.writeInt16LE(Math.round(s * 32768), i * 2));
  handle.output.write(`${JSON.stringify({ type: "audio", id, pcm: bytes.toString("base64"), sample_rate: sampleRate, done })}\n`);
}

const quantized = (v: number): number => Math.round(v * 32768) / 32768;

describe("firered shim 会话（fake daemon 驱动整句协议）", () => {
  it("ready 握手后整句合成：请求行带 ref_audio_path 与 prompt_text，单帧 done 交付", async () => {
    const { engine, fake } = makeShimEngine({
      startup: (output) => output.write('{"type":"ready","engine":"firered","version":"3","device":"mps"}\n'),
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
    expect(request.ref_audio_path).toBe(DEFAULT_REF);
    expect(request.prompt_text).toBe("对，所以说你现在的话，这个账单的话，你既然说能处理，那你就想办法处理掉。");
    expect(request.text_lang).toBe("zh");
  });

  it("spawn 参数携带 --repo 与 --models，FIRERED_DEVICE 按 darwin 默认注入 mps", async () => {
    const { engine, fake } = makeShimEngine({
      startup: (output) => output.write('{"type":"ready","engine":"firered","version":"3","device":"mps"}\n'),
      onRequest: (line, handle) => {
        const req = JSON.parse(line) as { id: number };
        writeAudio(handle, req.id, [0.5], true);
      },
    });
    await engine.speak("你好", speakOpts());
    const record = fake.daemons[0];
    expect(record?.args).toEqual([SHIM, "--repo", REPO, "--models", MODELS]);
    expect(record?.env?.FIRERED_DEVICE).toBe("mps");
  });

  it("用户显式设置的 FIRERED_DEVICE 胜出 darwin 默认", async () => {
    expect(fireredDevice({ FIRERED_DEVICE: "cpu" })).toBe("cpu");
    expect(fireredDevice({})).toBe("mps");
    expect(fireredDevice({}, "linux")).toBe("cpu");
    expect(fireredDevice({ FIRERED_DEVICE: "" }, "linux")).toBe("cpu");
  });

  it("stdout 先于 exit 终止：按输出终止快速收敛而非空转（EOF-exit 空窗回归锚）", async () => {
    const { engine } = makeShimEngine({
      startup: (output) => output.write('{"type":"ready","engine":"firered","version":"3","device":"mps"}\n'),
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
      startup: (output) => output.write('{"type":"ready","engine":"firered","version":"3","device":"mps"}\n'),
      onRequest: (_line, handle) => {
        setTimeout(() => handle.die("SIGKILL"), 20).unref();
      },
    });
    await expect(engine.speak("你好", speakOpts())).rejects.toBeInstanceOf(EngineError);
  });

  it("error 帧：EngineError 携带 shim 报的原因", async () => {
    const { engine } = makeShimEngine({
      startup: (output) => output.write('{"type":"ready","engine":"firered","version":"3","device":"mps"}\n'),
      onRequest: (line, handle) => {
        const req = JSON.parse(line) as { id: number };
        handle.output.write(`${JSON.stringify({ type: "error", id: req.id, message: "prompt_text 缺失" })}\n`);
      },
    });
    await expect(engine.speak("你好", speakOpts())).rejects.toThrow(/prompt_text 缺失/);
  });

  it("加载期 fatal：EngineError 携带 shim 报的原因", async () => {
    const { engine } = makeShimEngine({
      startup: (output) => output.write('{"type":"fatal","message":"权重缺失"}\n'),
    });
    await expect(engine.speak("你好", speakOpts())).rejects.toThrow(/权重缺失/);
  });

  it("同引擎实例多次合成复用同一进程；第二请求等第一合成完才发（互斥链）", async () => {
    const timings: string[] = [];
    const { engine, fake } = makeShimEngine({
      startup: (output) => output.write('{"type":"ready","engine":"firered","version":"3","device":"mps"}\n'),
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
    const engine = createFireredEngine({
      host: fake.host,
      labDir: LAB,
      voicesDir: VOICES,
      shimPath: SHIM,
      synth: createShimSynth(
        { labDir: LAB, repoDir: REPO, modelsDir: MODELS, pythonPath: "/nonexistent/python", shimPath: SHIM },
        fake.host,
      ),
    });
    await expect(engine.speak("你好", speakOpts())).rejects.toThrow(/FireRed/);
  });
});
