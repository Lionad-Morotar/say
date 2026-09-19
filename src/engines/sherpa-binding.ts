import { join } from "node:path";
import { EngineError, messageOf } from "../errors.ts";
import { withStderrMuted } from "../stderr.ts";
import type {
  OfflineTtsConfig,
  OfflineTtsInstance,
  SherpaOnnxModule,
} from "sherpa-onnx-node";

/** 进程内推理的接线缝：适配器只认这个函数签名，单测注入假实现即可覆盖全部路由与校验分支 */
export type SherpaModelSpec =
  | { kind: "kokoro"; dir: string }
  | { kind: "matcha"; dir: string; vocoder: string };

export interface SherpaSynthRequest {
  spec: SherpaModelSpec;
  text: string;
  sid: number;
  speed: number;
}

export interface SherpaSynthResult {
  samples: Float32Array;
  sampleRate: number;
  numSpeakers: number;
}

export type SherpaSynth = (request: SherpaSynthRequest) => Promise<SherpaSynthResult>;

/**
 * 钉定 fp32 权重：同版本的 int8 包经本绑定的动态 onnxruntime 产出全 NaN 静音，
 * 而同版本静态二进制读同一份 int8 权重出声正常，缺陷在绑定的量化算子路径上。
 * 代价是磁盘占用 326MB 而非 114MB，换来的是出声与可验证的音频能量。
 */
export const SHERPA_SUBDIR = "sherpa";
export const KOKORO_DIR_NAME = "kokoro-multi-lang-v1_1";
export const KOKORO_MODEL_FILE = "model.onnx";
export const MATCHA_DIR_NAME = "matcha-icefall-zh-baker";
export const MATCHA_MODEL_FILE = "model-steps-3.onnx";
export const VOCODER_FILE = "vocos-22khz-univ.onnx";

const NUM_THREADS = 2;
/** 逐句合成上限：批处理会把首句的出声时间推迟到整批算完，与「尽快出声」相悖 */
const MAX_NUM_SENTENCES = 1;

export function sherpaModelsDir(modelsDir: string): string {
  return join(modelsDir, SHERPA_SUBDIR);
}

export function kokoroModelDir(modelsDir: string): string {
  return join(sherpaModelsDir(modelsDir), KOKORO_DIR_NAME);
}

export function matchaModelDir(modelsDir: string): string {
  return join(sherpaModelsDir(modelsDir), MATCHA_DIR_NAME);
}

export function vocoderPath(modelsDir: string): string {
  return join(sherpaModelsDir(modelsDir), "vocoders", VOCODER_FILE);
}

export function kokoroRequiredFiles(dir: string): readonly string[] {
  return [
    KOKORO_MODEL_FILE,
    "voices.bin",
    "tokens.txt",
    "espeak-ng-data",
    "lexicon-us-en.txt",
    "lexicon-zh.txt",
    "date-zh.fst",
    "number-zh.fst",
  ].map((name) => join(dir, name));
}

export function matchaRequiredFiles(dir: string, vocoder: string): readonly string[] {
  return [
    ...[MATCHA_MODEL_FILE, "lexicon.txt", "tokens.txt", "date.fst", "number.fst", "phone.fst"].map((name) =>
      join(dir, name),
    ),
    vocoder,
  ];
}

function kokoroConfig(dir: string): OfflineTtsConfig {
  return {
    model: {
      kokoro: {
        model: join(dir, KOKORO_MODEL_FILE),
        voices: join(dir, "voices.bin"),
        tokens: join(dir, "tokens.txt"),
        dataDir: join(dir, "espeak-ng-data"),
        // 词典必须给绝对路径：native 按字面路径查找，不会以模型目录为基准解析
        lexicon: [join(dir, "lexicon-us-en.txt"), join(dir, "lexicon-zh.txt")].join(","),
      },
      numThreads: NUM_THREADS,
      provider: "cpu",
    },
    ruleFsts: [join(dir, "date-zh.fst"), join(dir, "number-zh.fst")].join(","),
    maxNumSentences: MAX_NUM_SENTENCES,
  };
}

function matchaConfig(dir: string, vocoder: string): OfflineTtsConfig {
  return {
    model: {
      matcha: {
        acousticModel: join(dir, MATCHA_MODEL_FILE),
        vocoder,
        lexicon: join(dir, "lexicon.txt"),
        tokens: join(dir, "tokens.txt"),
      },
      numThreads: NUM_THREADS,
      provider: "cpu",
    },
    ruleFsts: [join(dir, "date.fst"), join(dir, "number.fst"), join(dir, "phone.fst")].join(","),
    maxNumSentences: MAX_NUM_SENTENCES,
  };
}

function configOf(spec: SherpaModelSpec): OfflineTtsConfig {
  return spec.kind === "kokoro" ? kokoroConfig(spec.dir) : matchaConfig(spec.dir, spec.vocoder);
}

function cacheKeyOf(spec: SherpaModelSpec): string {
  return spec.kind === "kokoro" ? `kokoro:${spec.dir}` : `matcha:${spec.dir}:${spec.vocoder}`;
}

/** 模型句柄按规格缓存：一次调用内分块合成复用同一份权重，不重复付加载开销 */
const handles = new Map<string, OfflineTtsInstance>();

async function loadHandle(spec: SherpaModelSpec, sherpa: SherpaOnnxModule): Promise<OfflineTtsInstance> {
  const key = cacheKeyOf(spec);
  const cached = handles.get(key);
  if (cached !== undefined) return cached;
  const handle = await withStderrMuted(() => sherpa.OfflineTts.createAsync(configOf(spec)));
  handles.set(key, handle);
  return handle;
}

async function loadBinding(): Promise<SherpaOnnxModule> {
  try {
    // 惰性加载：走系统嗓的调用不该为用不到的绑定付出解析与失败面
    const module = await import("sherpa-onnx-node");
    return module.default;
  } catch (error) {
    throw new EngineError(`sherpa-onnx-node 加载失败：${messageOf(error)}`);
  }
}

export async function synthesizeWithBinding(request: SherpaSynthRequest): Promise<SherpaSynthResult> {
  const sherpa = await loadBinding();
  try {
    const handle = await loadHandle(request.spec, sherpa);
    const audio = await withStderrMuted(() =>
      handle.generateAsync({
        text: request.text,
        generationConfig: new sherpa.GenerationConfig({ sid: request.sid, speed: request.speed }),
      }),
    );
    return { samples: audio.samples, sampleRate: audio.sampleRate, numSpeakers: handle.numSpeakers };
  } catch (error) {
    if (error instanceof EngineError) throw error;
    throw new EngineError(`sherpa ${request.spec.kind} 合成失败：${messageOf(error)}`);
  }
}
