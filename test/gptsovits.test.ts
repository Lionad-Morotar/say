import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import {
  GPTSOVITS_ENGINE,
  createGptsovitsEngine,
  gptsovitsMissingAssets,
  detectTextLang,
  resolveLabPython,
} from "../src/engines/gptsovits.ts";
import { createShimSynth, type GptsovitsSynthRequest } from "../src/engines/gptsovits-binding.ts";
import type { ZipvoiceSynth } from "../src/engines/zipvoice-binding.ts";
import { createZipvoiceEngine } from "../src/engines/zipvoice.ts";
import { createRegistry, createDefaultRegistry, routeEngine } from "../src/engines/index.ts";
import { createSystemEngine } from "../src/engines/system.ts";
import { EngineError } from "../src/errors.ts";
import type { EngineAdapter, SpeakOptions } from "../src/types.ts";
import type { FakeDaemonHandle } from "./fake-host.ts";
import { createFakeHost } from "./fake-host.ts";

const LAB = "/lab/gptsovits";
const REPO = `${LAB}/GPT-SoVITS`;
const VOICES = "/data/voices";
const SHIM = "/say-repo/scripts/shims/gptsovits-shim.py";
const DEFAULT_DIR = "/say-repo/assets/engines/gptsovits";

const FRIEREN_META = JSON.stringify({
  character: "frieren",
  language: "ja",
  variants: { en: { language: "en" }, zh: { language: "zh" } },
});

/** 安装面五件套（venv + 内核 + 两份解压资产 + open_jtalk 字典的 .install-ok）在盘的基线环境 */
function makeFiles(extra: Record<string, string> = {}): Record<string, string> {
  return {
    [`${LAB}/venv/bin/python`]: "",
    [`${REPO}/GPT_SoVITS/TTS_infer_pack/TTS.py`]: "",
    [`${REPO}/GPT_SoVITS/pretrained_models/.install-ok`]: "",
    [`${REPO}/GPT_SoVITS/text/G2PWModel/.install-ok`]: "",
    [`${LAB}/open_jtalk_dic_utf_8-1.11/.install-ok`]: "",
    [`${VOICES}/frieren/meta.json`]: FRIEREN_META,
    [`${VOICES}/frieren/ref.wav`]: "",
    [`${VOICES}/frieren/ref.txt`]: "frieren transcript line\n# 转写来源: some-provenance\n",
    [`${VOICES}/frieren/ref-en.wav`]: "",
    [`${VOICES}/frieren/ref-en.txt`]: "frieren en transcript line\n",
    [`${DEFAULT_DIR}/default-zh.wav`]: "",
    [`${DEFAULT_DIR}/default-zh.txt`]: "今天上海天气很好。\n",
    [`${DEFAULT_DIR}/default-en.wav`]: "",
    [`${DEFAULT_DIR}/default-en.txt`]: "This is a reference audio.\n",
    ...extra,
  };
}

/** 假合成器：记录请求并返回可控样本，适配器逻辑不触 shim 进程 */
function fakeSynth(result: Partial<{ samples: Float32Array; sampleRate: number }> = {}) {
  const calls: GptsovitsSynthRequest[] = [];
  const synth = async (req: GptsovitsSynthRequest) => {
    calls.push(req);
    return {
      samples: result.samples ?? new Float32Array([0.1, -0.2, 0.3]),
      sampleRate: result.sampleRate ?? 32000,
    };
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
  synth: (req: GptsovitsSynthRequest) => Promise<{ samples: Float32Array; sampleRate: number }>,
  files: Record<string, string> = makeFiles(),
): { engine: EngineAdapter; fake: ReturnType<typeof createFakeHost> } {
  const fake = createFakeHost({ env: { HOME: "/h" }, files });
  const engine = createGptsovitsEngine({
    host: fake.host,
    labDir: LAB,
    voicesDir: VOICES,
    shimPath: SHIM,
    defaultVoiceDir: DEFAULT_DIR,
    synth,
  });
  return { engine, fake };
}

describe("gptsovits 安装面判据", () => {
  it("五件套齐全时 missing 为空", () => {
    const fake = createFakeHost({ env: { HOME: "/h" }, files: makeFiles() });
    const missing = gptsovitsMissingAssets(
      { labDir: LAB, repoDir: REPO, pythonPath: `${LAB}/venv/bin/python`, shimPath: SHIM },
      fake.host,
    );
    expect(missing).toEqual([]);
  });

  it("open_jtalk 字典的 .install-ok 缺失按缺项报：ja 文本不能拖到推理期才失败", () => {
    const files = makeFiles();
    delete files[`${LAB}/open_jtalk_dic_utf_8-1.11/.install-ok`];
    const fake = createFakeHost({ env: { HOME: "/h" }, files });
    const missing = gptsovitsMissingAssets(
      { labDir: LAB, repoDir: REPO, pythonPath: `${LAB}/venv/bin/python`, shimPath: SHIM },
      fake.host,
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain("open_jtalk_dic_utf_8-1.11/.install-ok");
  });

  it("resolveLabPython 认三形态 venv（与 engine-status 同构），spawn 与判据共用同一真源", () => {
    const expectPython = (files: Record<string, string>): string => resolveLabPython(LAB, createFakeHost({ env: { HOME: "/h" }, files }).host);
    expect(expectPython(makeFiles())).toBe(`${LAB}/venv/bin/python`);
    // uv sync 落点形态
    const dotVenv = makeFiles();
    delete dotVenv[`${LAB}/venv/bin/python`];
    dotVenv[`${LAB}/.venv/bin/python`] = "";
    expect(expectPython(dotVenv)).toBe(`${LAB}/.venv/bin/python`);
    // 装进仓库的形态
    const repoVenv = makeFiles();
    delete repoVenv[`${LAB}/venv/bin/python`];
    repoVenv[`${REPO}/.venv/bin/python`] = "";
    expect(expectPython(repoVenv)).toBe(`${REPO}/.venv/bin/python`);
    // 三形态全缺：回落规范形态，安装面判据照常报缺
    const none = makeFiles();
    delete none[`${LAB}/venv/bin/python`];
    expect(expectPython(none)).toBe(`${LAB}/venv/bin/python`);
  });

  it("解压资产的目录在而 .install-ok 缺失时按缺项报：半吊解压目录不算就绪", () => {
    const files = makeFiles();
    delete files[`${REPO}/GPT_SoVITS/pretrained_models/.install-ok`];
    const fake = createFakeHost({ env: { HOME: "/h" }, files });
    const missing = gptsovitsMissingAssets(
      { labDir: LAB, repoDir: REPO, pythonPath: `${LAB}/venv/bin/python`, shimPath: SHIM },
      fake.host,
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain("pretrained_models/.install-ok");
  });

  it("venv 缺失时不可用，原因点名安装脚本", async () => {
    const files = makeFiles();
    delete files[`${LAB}/venv/bin/python`];
    const { engine } = makeEngine(fakeSynth().synth, files);
    const availability = await engine.isAvailable(null);
    expect(availability.ok).toBe(false);
    if (!availability.ok) expect(availability.reason).toContain("install-engine.mjs gptsovits");
  });

  it("default 嗓参考资产缺失时不可用且点名资产目录", async () => {
    const files = makeFiles();
    delete files[`${DEFAULT_DIR}/default-en.wav`];
    const { engine } = makeEngine(fakeSynth().synth, files);
    const availability = await engine.isAvailable("default");
    expect(availability.ok).toBe(false);
    if (!availability.ok) expect(availability.reason).toContain(DEFAULT_DIR);
  });

  it("角色资产缺失时不可用，原因点名 ref 文件", async () => {
    const files = makeFiles();
    delete files[`${VOICES}/frieren/ref.wav`];
    const { engine } = makeEngine(fakeSynth().synth, files);
    const availability = await engine.isAvailable("frieren");
    expect(availability.ok).toBe(false);
    if (!availability.ok) expect(availability.reason).toContain("ref.wav");
  });

  it("认不出的音色名不在可用性层判死（路由层不会送过来）", async () => {
    const { engine } = makeEngine(fakeSynth().synth);
    expect(await engine.isAvailable("nosuch")).toEqual({ ok: true });
  });
});

describe("detectTextLang", () => {
  it("纯中文归 zh，纯英文归 en", () => {
    expect(detectTextLang("今天天气不错")).toBe("zh");
    expect(detectTextLang("hello world")).toBe("en");
  });

  it("中文占比达线归 zh，否则 en；纯标点数字归 zh（中文底线默认）", () => {
    expect(detectTextLang("今天是 Monday，天气不错")).toBe("zh");
    expect(detectTextLang("mostly english words with 一点中文")).toBe("en");
    expect(detectTextLang("1, 2, 3!")).toBe("zh");
  });
});

describe("gptsovits.speak（注入假合成器）", () => {
  it("default 嗓中文文本：参考指向内置 zh 资产、promptLang=zh、textLang 消费方自判 zh、语速换算 speed_factor", async () => {
    const { synth, calls } = fakeSynth();
    const { engine } = makeEngine(synth);
    const out = await engine.speak("你好世界", speakOpts({ rateWpm: 175 }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.refAudioPath).toBe(`${DEFAULT_DIR}/default-zh.wav`);
    expect(calls[0]!.promptText).toBe("今天上海天气很好。");
    expect(calls[0]!.promptLang).toBe("zh");
    expect(calls[0]!.textLang).toBe("zh");
    expect(calls[0]!.speedFactor).toBe(1);
    expect(out).toEqual({ type: "pcm", samples: new Float32Array([0.1, -0.2, 0.3]), sampleRate: 32000 });
  });

  it("default 嗓英文文本：参考自动切到内置 en 资产", async () => {
    const { synth, calls } = fakeSynth();
    const { engine } = makeEngine(synth);
    await engine.speak("hello there", speakOpts());
    expect(calls[0]!.refAudioPath).toBe(`${DEFAULT_DIR}/default-en.wav`);
    expect(calls[0]!.promptLang).toBe("en");
  });

  it("角色嗓：ref.wav 一比一映射、转写剥离溯源注释、meta language 作 prompt_lang", async () => {
    const { synth, calls } = fakeSynth();
    const { engine } = makeEngine(synth);
    await engine.speak("こんにちは", speakOpts({ voice: "frieren" }));
    expect(calls[0]!.refAudioPath).toBe(`${VOICES}/frieren/ref.wav`);
    expect(calls[0]!.promptText).toBe("frieren transcript line");
    expect(calls[0]!.promptLang).toBe("ja");
  });

  it("角色语言变体：meta variants 的语言进 prompt_lang", async () => {
    const { synth, calls } = fakeSynth();
    const { engine } = makeEngine(synth);
    await engine.speak("hi", speakOpts({ voice: "frieren-en" }));
    expect(calls[0]!.promptLang).toBe("en");
  });

  it("空样本不交付：能量校验失败抛 EngineError 交回退层", async () => {
    const { synth } = fakeSynth({ samples: new Float32Array(0) });
    const { engine } = makeEngine(synth);
    await expect(engine.speak("你好", speakOpts())).rejects.toBeInstanceOf(EngineError);
  });

  it("未登记的角色名报精确原因（点 voicesDir）", async () => {
    const { engine } = makeEngine(fakeSynth().synth);
    await expect(engine.speak("hi", speakOpts({ voice: "nosuch" }))).rejects.toThrow(/nosuch/);
  });
});

describe("gptsovits 注册表接线", () => {
  it("ownsVoice 认领在盘角色，default 不认领（不劫持路由仲裁）", async () => {
    const { engine } = makeEngine(fakeSynth().synth);
    expect(engine.ownsVoice?.("frieren")).toBe(true);
    expect(engine.ownsVoice?.("frieren-zh")).toBe(true);
    expect(engine.ownsVoice?.("default")).toBe(false);
    expect(engine.ownsVoice?.("nosuch")).toBe(false);
  });

  it("listVoices 含 default 关键字与角色（含语言变体）", async () => {
    const { engine } = makeEngine(fakeSynth().synth);
    const voices = await engine.listVoices();
    const names = voices.map((v) => v.name);
    expect(names).toContain("default");
    expect(names).toContain("frieren");
    expect(names).toContain("frieren-en");
    expect(names).toContain("frieren-zh");
    expect(voices.every((v) => v.engine === GPTSOVITS_ENGINE)).toBe(true);
  });

  it("engine=gptsovits 时路由命中适配器；角色名归属不变", async () => {
    const fake = createFakeHost({ env: { HOME: "/h" }, files: makeFiles() });
    const registry = createRegistry([makeEngine(fakeSynth().synth, makeFiles()).engine, createSystemEngine(fake.host, "/usr/bin/say")]);
    const config = {
      engine: GPTSOVITS_ENGINE,
      voice: null,
      rateWpm: 175,
      fallback: "system" as const,
      debug: false,
    };
    const routed = await routeEngine(config, registry);
    expect(routed.engine?.name).toBe(GPTSOVITS_ENGINE);
    const byVoice = await routeEngine({ ...config, voice: "frieren" }, registry);
    expect(byVoice.engine?.name).toBe(GPTSOVITS_ENGINE);
    expect(byVoice.voice).toBe("frieren");
  });

  it("显式 -e gptsovits 压过登记序：与 zipvoice 共享角色目录时不被先登记者劫持", async () => {
    const files = makeFiles();
    const fake = createFakeHost({ env: { HOME: "/h" }, files });
    const zipSynth: ZipvoiceSynth = async () => ({ samples: new Float32Array([0]), sampleRate: 24000 });
    const zipvoice = createZipvoiceEngine({ host: fake.host, modelsDir: "/models", voicesDir: VOICES, synth: zipSynth });
    // 登记序 zipvoice 在前：纯登记序仲裁下 frieren 会在 zipvoice 处命中
    const registry = createRegistry([zipvoice, makeEngine(fakeSynth().synth, files).engine, createSystemEngine(fake.host, "/usr/bin/say")]);
    const routed = await routeEngine(
      { engine: GPTSOVITS_ENGINE, voice: "frieren", rateWpm: 175, fallback: "system" as const, debug: false },
      registry,
    );
    expect(routed.engine?.name).toBe(GPTSOVITS_ENGINE);
    expect(routed.voice).toBe("frieren");
  });

  it("createDefaultRegistry 登记即接线：engine 名可查", () => {
    const fake = createFakeHost({ env: { HOME: "/h" }, files: makeFiles() });
    const registry = createDefaultRegistry(fake.host);
    expect(registry.names()).toContain(GPTSOVITS_ENGINE);
  });
});

/** 驱动假 shim 行为的工厂：startup 写就绪/致命帧，onRequest 按请求行回写响应 */
interface ShimBehavior {
  startup?: (output: PassThrough, errors: PassThrough) => void;
  onRequest?: (line: string, handle: FakeDaemonHandle) => void;
  dieAfterStartMs?: number;
}

function makeShimEngine(behavior: ShimBehavior): { engine: EngineAdapter; fake: ReturnType<typeof createFakeHost> } {
  const fake = createFakeHost({
    env: { HOME: "/h" },
    files: makeFiles(),
    daemonFactory: () => {
      const output = new PassThrough();
      const errors = new PassThrough();
      behavior.startup?.(output, errors);
      if (behavior.dieAfterStartMs !== undefined) {
        setTimeout(() => output.end(), behavior.dieAfterStartMs).unref();
      }
      return {
        output,
        errors,
        onRequest: (line, handle) => behavior.onRequest?.(line, handle),
      };
    },
  });
  const engine = createGptsovitsEngine({
    host: fake.host,
    labDir: LAB,
    voicesDir: VOICES,
    shimPath: SHIM,
    defaultVoiceDir: DEFAULT_DIR,
    synth: createShimSynth(
      { labDir: LAB, repoDir: REPO, pythonPath: "/usr/bin/env", shimPath: SHIM },
      fake.host,
    ),
  });
  return { engine, fake };
}

/** 等待 daemon 控制柄就绪（spawnDaemon 同步入列，取首个） */
function handleOf(fake: ReturnType<typeof createFakeHost>): FakeDaemonHandle {
  const handle = fake.daemonHandles[0];
  if (handle === undefined) throw new Error("daemon 未拉起");
  return handle;
}

function writeAudioDone(handle: FakeDaemonHandle, id: number, samples: readonly number[], sampleRate = 32000): void {
  const bytes = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => bytes.writeInt16LE(Math.round(s * 32768), i * 2));
  handle.output.write(`${JSON.stringify({ type: "audio", id, pcm: bytes.toString("base64"), sample_rate: sampleRate, done: true })}\n`);
}

describe("gptsovits shim 会话（fake daemon 驱动协议）", () => {
  it("ready 握手后合成：请求行写出、audio 帧解码为样本、采样率透传", async () => {
    const { engine, fake } = makeShimEngine({
      startup: (output) => output.write('{"type":"ready","engine":"gptsovits","version":"v2","device":"cpu"}\n'),
      onRequest: (line, handle) => {
        const req = JSON.parse(line) as { id: number };
        writeAudioDone(handle, req.id, [0.5, -0.5]);
      },
    });
    const out = await engine.speak("你好", speakOpts());
    expect(out).toEqual({
      type: "pcm",
      samples: new Float32Array([0.5, -0.5]),
      sampleRate: 32000,
    });
    const request = JSON.parse(handleOf(fake).requests[0]!) as Record<string, unknown>;
    expect(request.type).toBe("synthesize");
    expect(request.text).toBe("你好");
    expect(request.ref_audio_path).toBe(`${DEFAULT_DIR}/default-zh.wav`);
    expect(request.text_split_method).toBeUndefined(); // 切分参数由 shim 侧钉死，协议请求不带
    expect(handleOf(fake).requests[0]!.endsWith("\n")).toBe(false); // requests 已剥行尾换行
  });

  it("加载期 fatal：EngineError 携带 shim 报的原因", async () => {
    const { engine } = makeShimEngine({
      startup: (output) => output.write('{"type":"fatal","message":"权重缺失: s2G2333k.pth"}\n'),
    });
    await expect(engine.speak("你好", speakOpts())).rejects.toThrow(/权重缺失/);
  });

  it("spawn 本身失败（解释器不存在）按加载期退出收敛", async () => {
    const fake = createFakeHost({
      env: { HOME: "/h" },
      files: makeFiles(),
      daemonFactory: () => null,
    });
    const engine = createGptsovitsEngine({
      host: fake.host,
      labDir: LAB,
      voicesDir: VOICES,
      shimPath: SHIM,
      defaultVoiceDir: DEFAULT_DIR,
      synth: createShimSynth({ labDir: LAB, repoDir: REPO, pythonPath: "/nonexistent/python", shimPath: SHIM }, fake.host),
    });
    await expect(engine.speak("你好", speakOpts())).rejects.toThrow(/GPT-SoVITS/);
  });

  it("加载期进程直接死亡：EngineError 引 stderr 现场末行", async () => {
    const { engine, fake } = makeShimEngine({
      startup: (_output, errors) => errors.write("ModuleNotFoundError: No module named 'torch'\n"),
    });
    const promise = engine.speak("你好", speakOpts());
    // 会话惰性拉起：让 speak 的微任务链走完（spawn 完成）再驱动死亡
    await new Promise((resolve) => setTimeout(resolve, 10));
    handleOf(fake).die("SIGKILL");
    await expect(promise).rejects.toThrow(/ModuleNotFoundError|退出/);
  });

  it("stdout 先于 exit 终止：按输出终止快速收敛而非空转（EOF-exit 空窗回归锚）", async () => {
    const { engine } = makeShimEngine({
      startup: (output) => output.write('{"type":"ready","engine":"gptsovits","version":"v2","device":"cpu"}\n'),
      onRequest: (line, handle) => {
        const req = JSON.parse(line) as { id: number };
        const bytes = Buffer.alloc(2);
        bytes.writeInt16LE(Math.round(0.5 * 32768));
        handle.output.write(`${JSON.stringify({ type: "audio", id: req.id, pcm: bytes.toString("base64"), sample_rate: 32000, done: false })}\n`);
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

  it("合成期进程死亡：EngineError 而非悬挂", async () => {
    const { engine } = makeShimEngine({
      startup: (output) => output.write('{"type":"ready","engine":"gptsovits","version":"v2","device":"cpu"}\n'),
      onRequest: (_line, handle) => {
        // 请求收到但不响应，模拟合成中崩溃
        setTimeout(() => handle.die("SIGKILL"), 30).unref();
      },
    });
    await expect(engine.speak("你好", speakOpts())).rejects.toBeInstanceOf(EngineError);
  });

  it("合成期 error 帧：EngineError 携带 shim 报的原因", async () => {
    const { engine } = makeShimEngine({
      startup: (output) => output.write('{"type":"ready","engine":"gptsovits","version":"v2","device":"cpu"}\n'),
      onRequest: (line, handle) => {
        const req = JSON.parse(line) as { id: number };
        handle.output.write(`${JSON.stringify({ type: "error", id: req.id, message: "ref_audio_path 不存在" })}\n`);
      },
    });
    await expect(engine.speak("你好", speakOpts())).rejects.toThrow(/ref_audio_path 不存在/);
  });

  it("同引擎实例多次合成复用同一进程（热态），进程拉起只此一次", async () => {
    const { engine, fake } = makeShimEngine({
      startup: (output) => output.write('{"type":"ready","engine":"gptsovits","version":"v2","device":"cpu"}\n'),
      onRequest: (line, handle) => {
        const req = JSON.parse(line) as { id: number };
        writeAudioDone(handle, req.id, [0.1]);
      },
    });
    await engine.speak("第一句", speakOpts());
    await engine.speak("第二句", speakOpts());
    expect(fake.daemons).toHaveLength(1);
    expect(handleOf(fake).requests).toHaveLength(2);
  });

  it("引擎输出杂散行（非协议 JSON）被丢弃不毒化协议面", async () => {
    const { engine } = makeShimEngine({
      startup: (output) => {
        output.write("并行推理模式已开启\n"); // 引擎 i18n print 混入协议流的形态
        output.write('{"type":"ready","engine":"gptsovits","version":"v2","device":"cpu"}\n');
      },
      onRequest: (line, handle) => {
        const req = JSON.parse(line) as { id: number };
        handle.output.write("0.412\t0.031\t1.204\t0.662\n"); // 耗时统计行
        writeAudioDone(handle, req.id, [0.2]);
      },
    });
    const out = await engine.speak("你好", speakOpts());
    if (out.type !== "pcm") throw new Error("期待 pcm 产出");
    // int16 往返有量化误差（0.2 → 6554/32768），断言对齐编码-解码的同一换算
    expect(out.samples[0]).toBeCloseTo(Math.round(0.2 * 32768) / 32768, 6);
  });

  it("多块流式音频聚合到 done=true 才交付：第二块起不丢（协议文档承诺的拼接语义）", async () => {
    const { engine } = makeShimEngine({
      startup: (output) => output.write('{"type":"ready","engine":"gptsovits","version":"v2","device":"cpu"}\n'),
      onRequest: (line, handle) => {
        const req = JSON.parse(line) as { id: number };
        const writeChunk = (samples: readonly number[], done: boolean) => {
          const bytes = Buffer.alloc(samples.length * 2);
          samples.forEach((s, i) => bytes.writeInt16LE(Math.round(s * 32768), i * 2));
          handle.output.write(`${JSON.stringify({ type: "audio", id: req.id, pcm: bytes.toString("base64"), sample_rate: 32000, done })}\n`);
        };
        writeChunk([0.5], false);
        writeChunk([-0.5, 0.25], true);
      },
    });
    const out = await engine.speak("你好", speakOpts());
    const quantized = (v: number) => Math.round(v * 32768) / 32768;
    expect(out).toEqual({
      type: "pcm",
      samples: new Float32Array([quantized(0.5), quantized(-0.5), quantized(0.25)]),
      sampleRate: 32000,
    });
  });
});
