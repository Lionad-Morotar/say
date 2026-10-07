import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import {
  VOXCPM_ENGINE,
  createVoxcpmEngine,
  resolveLabPython,
  voxcpmMissingAssets,
} from "../src/engines/voxcpm.ts";
import { createShimStreamSynth, type VoxcpmSynthRequest } from "../src/engines/voxcpm-binding.ts";
import { createRegistry, createDefaultRegistry, routeEngine } from "../src/engines/index.ts";
import { createSystemEngine } from "../src/engines/system.ts";
import { EngineError } from "../src/errors.ts";
import type { EngineAdapter, SpeakOptions } from "../src/types.ts";
import type { FakeDaemonHandle } from "./fake-host.ts";
import { createFakeHost } from "./fake-host.ts";

const LAB = "/lab/voxcpm";
const MODELS = `${LAB}/models`;
const VOICES = "/data/voices";
const SHIM = "/say-repo/scripts/shims/voxcpm-shim.py";

const FRIEREN_META = JSON.stringify({
  character: "frieren",
  language: "ja",
  variants: { en: { language: "en" }, zh: { language: "zh" } },
});

/** 安装面八件套（venv + models 七文件，engine-manifest.mjs VOXCPM.weights 的落位清单）在盘的基线环境 */
function makeFiles(extra: Record<string, string> = {}): Record<string, string> {
  return {
    [`${LAB}/venv/bin/python`]: "",
    [`${MODELS}/model.safetensors`]: "",
    [`${MODELS}/audiovae.pth`]: "",
    [`${MODELS}/config.json`]: "",
    [`${MODELS}/tokenizer.json`]: "",
    [`${MODELS}/tokenizer_config.json`]: "",
    [`${MODELS}/special_tokens_map.json`]: "",
    [`${MODELS}/tokenization_voxcpm2.py`]: "",
    [`${VOICES}/frieren/meta.json`]: FRIEREN_META,
    [`${VOICES}/frieren/ref.wav`]: "",
    [`${VOICES}/frieren/ref.txt`]: "frieren transcript line\n# 转写来源: some-provenance\n",
    [`${VOICES}/frieren/ref-en.wav`]: "",
    [`${VOICES}/frieren/ref-en.txt`]: "frieren en transcript line\n",
    ...extra,
  };
}

/** 假流式合成器：记录请求并按脚本产出可控块序列 */
function fakeSynth(script: (req: VoxcpmSynthRequest) => Array<{ samples?: number[]; sampleRate?: number; fail?: boolean }>) {
  const calls: VoxcpmSynthRequest[] = [];
  const synth = async function* (req: VoxcpmSynthRequest) {
    calls.push(req);
    for (const step of script(req)) {
      if (step.fail) throw new EngineError("流式合成炸了");
      yield { samples: new Float32Array(step.samples ?? [0.1, -0.2]), sampleRate: step.sampleRate ?? 48000, done: false };
    }
    // 尾块标记进最后一步：脚本不关心 done 位（adapter 也不消费它，消费契约是「迭代耗尽即完成」）
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
  synth: (req: VoxcpmSynthRequest) => AsyncGenerator<{ samples: Float32Array; sampleRate: number; done: boolean }>,
  files: Record<string, string> = makeFiles(),
): { engine: EngineAdapter; fake: ReturnType<typeof createFakeHost> } {
  const fake = createFakeHost({ env: { HOME: "/h" }, files });
  const engine = createVoxcpmEngine({
    host: fake.host,
    labDir: LAB,
    voicesDir: VOICES,
    shimPath: SHIM,
    synth: synth as never,
  });
  return { engine, fake };
}

describe("voxcpm 安装面判据", () => {
  it("八件套齐全时 missing 为空", () => {
    const fake = createFakeHost({ env: { HOME: "/h" }, files: makeFiles() });
    const missing = voxcpmMissingAssets(
      { labDir: LAB, modelsDir: MODELS, pythonPath: `${LAB}/venv/bin/python`, shimPath: SHIM },
      fake.host,
    );
    expect(missing).toEqual([]);
  });

  it("缺任一权重文件按缺项报，原因点名安装脚本", async () => {
    const files = makeFiles();
    delete files[`${MODELS}/audiovae.pth`];
    const { engine } = makeEngine(fakeSynth(() => []).synth, files);
    const availability = await engine.isAvailable(null);
    expect(availability.ok).toBe(false);
    if (!availability.ok) {
      expect(availability.reason).toContain("audiovae.pth");
      expect(availability.reason).toContain("install-engine.mjs voxcpm");
    }
  });

  it("resolveLabPython 认三形态 venv（与 engine-status 同构）", () => {
    const expectPython = (files: Record<string, string>): string =>
      resolveLabPython(LAB, createFakeHost({ env: { HOME: "/h" }, files }).host);
    expect(expectPython(makeFiles())).toBe(`${LAB}/venv/bin/python`);
    const dotVenv = makeFiles();
    delete dotVenv[`${LAB}/venv/bin/python`];
    dotVenv[`${LAB}/.venv/bin/python`] = "";
    expect(expectPython(dotVenv)).toBe(`${LAB}/.venv/bin/python`);
    const repoVenv = makeFiles();
    delete repoVenv[`${LAB}/venv/bin/python`];
    repoVenv[`${LAB}/VoxCPM/.venv/bin/python`] = "";
    expect(expectPython(repoVenv)).toBe(`${LAB}/VoxCPM/.venv/bin/python`);
  });

  it("default 嗓不依赖任何参考资产（voice creation 是纯文本描述形态）", async () => {
    const { engine } = makeEngine(fakeSynth(() => []).synth);
    expect(await engine.isAvailable(null)).toEqual({ ok: true });
    expect(await engine.isAvailable("default")).toEqual({ ok: true });
  });

  it("角色资产缺失时不可用，原因点名 ref 文件", async () => {
    const files = makeFiles();
    delete files[`${VOICES}/frieren/ref.wav`];
    const { engine } = makeEngine(fakeSynth(() => []).synth, files);
    const availability = await engine.isAvailable("frieren");
    expect(availability.ok).toBe(false);
    if (!availability.ok) expect(availability.reason).toContain("ref.wav");
  });
});

describe("voxcpm.speak / speakStreaming（注入假合成器）", () => {
  it("default 嗓走 voice creation：无参考、请求带内置 control 描述", async () => {
    const { synth, calls } = fakeSynth(() => [{ samples: [0.1] }]);
    const { engine } = makeEngine(synth);
    const out = await engine.speak("你好世界", speakOpts());
    expect(calls[0]!.refAudioPath).toBeNull();
    expect(calls[0]!.promptText).toBeNull();
    expect(calls[0]!.control).not.toBeNull();
    expect(out).toEqual({ type: "pcm", samples: new Float32Array([0.1]), sampleRate: 48000 });
  });

  it("角色嗓：ref.wav 一比一映射、转写剥离溯源注释、control 不带", async () => {
    const { synth, calls } = fakeSynth(() => [{ samples: [0.3] }]);
    const { engine } = makeEngine(synth);
    await engine.speak("こんにちは", speakOpts({ voice: "frieren" }));
    expect(calls[0]!.refAudioPath).toBe(`${VOICES}/frieren/ref.wav`);
    expect(calls[0]!.promptText).toBe("frieren transcript line");
    expect(calls[0]!.control).toBeNull();
  });

  it("speakStreaming 逐块产出并带采样率，speak 收集到同一拼样本", async () => {
    const script = [{ samples: [0.1] }, { samples: [-0.2, 0.3] }, { samples: [0.5] }];
    const { engine } = makeEngine(fakeSynth(() => script).synth);
    const streamed: number[] = [];
    for await (const out of engine.speakStreaming!("你好", speakOpts())) {
      streamed.push(...out.samples);
      expect(out.type).toBe("pcm");
    }
    // Float32 精度：期望值经同一 Float32 通道展开，逐位对齐而非十进制字面量对齐
    const expected = [...Float32Array.from([0.1, -0.2, 0.3, 0.5])];
    expect(streamed).toEqual(expected);
    const whole = await engine.speak("你好", speakOpts());
    expect(whole.type).toBe("pcm");
    if (whole.type === "pcm") expect([...whole.samples]).toEqual(expected);
  });

  it("NaN 样本任何块出现都按失败收敛，speak 不交付静音垃圾", async () => {
    const { engine } = makeEngine(
      fakeSynth(() => [{ samples: [0.1] }, { samples: [Number.NaN] }]).synth,
    );
    await expect(engine.speak("你好", speakOpts())).rejects.toBeInstanceOf(EngineError);
    const collected: number[] = [];
    await expect(
      (async () => {
        for await (const out of engine.speakStreaming!("你好", speakOpts())) collected.push(...out.samples);
      })(),
    ).rejects.toBeInstanceOf(EngineError);
    // 第一块正常转交，NaN 在第二块爆炸
    expect(collected).toEqual([...Float32Array.from([0.1])]);
  });

  it("空产出不交付：能量校验失败抛 EngineError 交回退层", async () => {
    const { engine } = makeEngine(fakeSynth(() => []).synth);
    await expect(engine.speak("你好", speakOpts())).rejects.toThrow(/空样本/);
  });

  it("未登记的角色名报精确原因（点 voicesDir）", async () => {
    const { engine } = makeEngine(fakeSynth(() => []).synth);
    await expect(engine.speak("hi", speakOpts({ voice: "nosuch" }))).rejects.toThrow(/nosuch/);
  });
});

describe("voxcpm 注册表接线", () => {
  it("ownsVoice 认领在盘角色，default 不认领（不劫持路由仲裁）", () => {
    const { engine } = makeEngine(fakeSynth(() => []).synth);
    expect(engine.ownsVoice?.("frieren")).toBe(true);
    expect(engine.ownsVoice?.("frieren-zh")).toBe(true);
    expect(engine.ownsVoice?.("default")).toBe(false);
    expect(engine.ownsVoice?.("nosuch")).toBe(false);
  });

  it("listVoices 含 default 关键字与角色（含语言变体）", async () => {
    const { engine } = makeEngine(fakeSynth(() => []).synth);
    const voices = await engine.listVoices();
    const names = voices.map((v) => v.name);
    expect(names).toContain("default");
    expect(names).toContain("frieren");
    expect(names).toContain("frieren-en");
    expect(voices.every((v) => v.engine === VOXCPM_ENGINE)).toBe(true);
  });

  it("engine=voxcpm 时路由命中适配器；显式 -e voxcpm 压过共享角色目录的登记序", async () => {
    const fake = createFakeHost({ env: { HOME: "/h" }, files: makeFiles() });
    const registry = createRegistry([makeEngine(fakeSynth(() => []).synth).engine, createSystemEngine(fake.host, "/usr/bin/say")]);
    const config = { engine: VOXCPM_ENGINE, voice: null, rateWpm: 175, fallback: "system" as const, debug: false };
    const routed = await routeEngine(config, registry);
    expect(routed.engine?.name).toBe(VOXCPM_ENGINE);
    const byVoice = await routeEngine({ ...config, voice: "frieren" }, registry);
    expect(byVoice.engine?.name).toBe(VOXCPM_ENGINE);
    expect(byVoice.voice).toBe("frieren");
  });

  it("createDefaultRegistry 登记即接线：engine 名可查", () => {
    const fake = createFakeHost({ env: { HOME: "/h" }, files: makeFiles() });
    const registry = createDefaultRegistry(fake.host);
    expect(registry.names()).toContain(VOXCPM_ENGINE);
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
  const engine = createVoxcpmEngine({
    host: fake.host,
    labDir: LAB,
    voicesDir: VOICES,
    shimPath: SHIM,
    synth: createShimStreamSynth(
      { labDir: LAB, modelsDir: MODELS, pythonPath: "/usr/bin/env", shimPath: SHIM },
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

function writeAudio(handle: FakeDaemonHandle, id: number, samples: readonly number[], done: boolean, sampleRate = 48000): void {
  const bytes = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => bytes.writeInt16LE(Math.round(s * 32768), i * 2));
  handle.output.write(`${JSON.stringify({ type: "audio", id, pcm: bytes.toString("base64"), sample_rate: sampleRate, done })}\n`);
}

const quantized = (v: number): number => Math.round(v * 32768) / 32768;

describe("voxcpm shim 会话（fake daemon 驱动流式协议）", () => {
  it("ready 握手后流式合成：请求行带 control 字段，多块按到达序转交", async () => {
    const { engine, fake } = makeShimEngine({
      startup: (output) => output.write('{"type":"ready","engine":"voxcpm","version":"VoxCPM2Model","device":"mps"}\n'),
      onRequest: (line, handle) => {
        const req = JSON.parse(line) as { id: number };
        writeAudio(handle, req.id, [0.5], false);
        writeAudio(handle, req.id, [-0.5], false);
        writeAudio(handle, req.id, [0.25], true);
      },
    });
    const chunks: number[][] = [];
    for await (const out of engine.speakStreaming!("(描述)你好", speakOpts())) chunks.push([...out.samples]);
    expect(chunks).toEqual([[quantized(0.5)], [quantized(-0.5)], [quantized(0.25)]]);
    const request = JSON.parse(handleOf(fake).requests[0]!) as Record<string, unknown>;
    expect(request.type).toBe("synthesize");
    // voice=null 也落 default 语义：control 携带内置 voice creation 描述
    expect(typeof request.control).toBe("string");
  });

  it("default 嗓的请求形态：ref_audio_path 为空串（无参考）、control 携带描述", async () => {
    const { engine, fake } = makeShimEngine({
      startup: (output) => output.write('{"type":"ready","engine":"voxcpm","version":"VoxCPM2Model","device":"mps"}\n'),
      onRequest: (line, handle) => {
        const req = JSON.parse(line) as { id: number };
        writeAudio(handle, req.id, [0.5], true);
      },
    });
    await engine.speak("你好", speakOpts());
    const request = JSON.parse(handleOf(fake).requests[0]!) as Record<string, unknown>;
    expect(request.ref_audio_path).toBe("");
    expect(request.prompt_text).toBe("");
    expect(typeof request.control).toBe("string");
  });

  it("stdout 先于 exit 终止：按输出终止快速收敛而非空转（EOF-exit 空窗回归锚）", async () => {
    const { engine } = makeShimEngine({
      startup: (output) => output.write('{"type":"ready","engine":"voxcpm","version":"VoxCPM2Model","device":"mps"}\n'),
      onRequest: (line, handle) => {
        const req = JSON.parse(line) as { id: number };
        writeAudio(handle, req.id, [0.5], false);
        // 流先关、exit 300ms 后才 settle：真机 SIGKILL 后 EOF 与 exit 事件空窗的放大形态
        handle.output.end();
        setTimeout(() => handle.die("SIGKILL"), 300).unref();
      },
    });
    const started = Date.now();
    await expect(
      (async () => {
        for await (const _ of engine.speakStreaming!("你好", speakOpts())) void _;
      })(),
    ).rejects.toThrow(/输出已终止/);
    // 快速收敛 = 没在空窗里空转（修前形态：每圈一个 deadline 定时器，毫秒级烧穿堆）
    expect(Date.now() - started).toBeLessThan(300);
  });

  it("中途进程死亡：已收块之后抛 EngineError 而非悬挂", async () => {
    const { engine } = makeShimEngine({
      startup: (output) => output.write('{"type":"ready","engine":"voxcpm","version":"VoxCPM2Model","device":"mps"}\n'),
      onRequest: (_line, handle) => {
        writeAudio(handle, 1, [0.5], false);
        setTimeout(() => handle.die("SIGKILL"), 20).unref();
      },
    });
    await expect((async () => {
      for await (const _ of engine.speakStreaming!("你好", speakOpts())) {
        // 第一块到达后继续等第二块，此时进程死亡
      }
    })()).rejects.toBeInstanceOf(EngineError);
  });

  it("error 帧：EngineError 携带 shim 报的原因", async () => {
    const { engine } = makeShimEngine({
      startup: (output) => output.write('{"type":"ready","engine":"voxcpm","version":"VoxCPM2Model","device":"mps"}\n'),
      onRequest: (line, handle) => {
        const req = JSON.parse(line) as { id: number };
        handle.output.write(`${JSON.stringify({ type: "error", id: req.id, message: "ref_audio_path 不存在" })}\n`);
      },
    });
    await expect((async () => {
      for await (const _ of engine.speakStreaming!("你好", speakOpts())) throw new Error("不应到达");
    })()).rejects.toThrow(/ref_audio_path 不存在/);
  });

  it("加载期 fatal：EngineError 携带 shim 报的原因", async () => {
    const { engine } = makeShimEngine({
      startup: (output) => output.write('{"type":"fatal","message":"config.json 损坏"}\n'),
    });
    await expect(engine.speak("你好", speakOpts())).rejects.toThrow(/config.json 损坏/);
  });

  it("同引擎实例多次合成复用同一进程；第二请求等第一流耗尽才发（互斥门）", async () => {
    const timings: string[] = [];
    const { engine, fake } = makeShimEngine({
      startup: (output) => output.write('{"type":"ready","engine":"voxcpm","version":"VoxCPM2Model","device":"mps"}\n'),
      onRequest: (line, handle) => {
        const req = JSON.parse(line) as { id: number; text: string };
        timings.push(`start:${req.text}`);
        // 两块间插入微任务间隙，让互斥门的排队语义可分辨
        writeAudio(handle, req.id, [0.1], false);
        setTimeout(() => {
          writeAudio(handle, req.id, [0.2], true);
          timings.push(`end:${req.text}`);
        }, 10).unref();
      },
    });
    const first = engine.speakStreaming!("第一句", speakOpts());
    const second = engine.speakStreaming!("第二句", speakOpts());
    for await (const _ of first) void _;
    for await (const _ of second) void _;
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
    const engine = createVoxcpmEngine({
      host: fake.host,
      labDir: LAB,
      voicesDir: VOICES,
      shimPath: SHIM,
      synth: createShimStreamSynth({ labDir: LAB, modelsDir: MODELS, pythonPath: "/nonexistent/python", shimPath: SHIM }, fake.host),
    });
    await expect(engine.speak("你好", speakOpts())).rejects.toThrow(/VoxCPM/);
  });
});
