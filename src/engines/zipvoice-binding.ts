import { join } from "node:path";
import { EngineError, messageOf } from "../errors.ts";
import { withStderrMuted } from "../stderr.ts";
import type {
  GenerationConfigOptions,
  OfflineTtsConfig,
  OfflineTtsInstance,
  SherpaOnnxModule,
} from "sherpa-onnx-node";

/**
 * 进程内克隆推理的接线缝，形态对齐 sherpa-binding.ts：
 * 适配器只认这个函数签名，单测注入假实现即可覆盖路由、可用性与校验分支。
 * 与 kokoro/matcha 不同，克隆请求还携带参考音频与逐字转写（零样本克隆的必需要件），
 * 路径由适配层解析、文件读取归本层——绑定层是唯一触 native 的位置。
 */
export interface ZipvoiceSpec {
  dir: string;
  /** vocos 24kHz：克隆链路专用，与 kokoro/matcha 的 vocos-22khz 不通用 */
  vocoder: string;
}

export interface ZipvoiceSynthRequest {
  spec: ZipvoiceSpec;
  text: string;
  speed: number;
  /** 参考音频的绝对路径（readWave 读取），与参考转写逐字配对是克隆相似度的第一变量 */
  referenceAudioPath: string;
  /** 参考音频的逐字转写（已剥离溯源注释），由适配层经 host 读取 */
  referenceText: string;
}

export interface ZipvoiceSynthResult {
  samples: Float32Array;
  sampleRate: number;
}

export type ZipvoiceSynth = (request: ZipvoiceSynthRequest) => Promise<ZipvoiceSynthResult>;

/**
 * 钉定 distill int8 权重与 4 步流匹配：官方示例口径，加大步数收益甚微（flow-mem 实测记录）。
 * int8 权重经本绑定出声正常（kokoro 的 int8 NaN 缺陷不在 zipvoice 路径上，bench 与冒烟双证据）。
 */
export const SHERPA_SUBDIR = "sherpa";
export const ZIPVOICE_DIR_NAME = "sherpa-onnx-zipvoice-distill-int8-zh-en-emilia";
export const ZIPVOICE_ENCODER_FILE = "encoder.int8.onnx";
export const ZIPVOICE_DECODER_FILE = "decoder.int8.onnx";
export const ZIPVOICE_VOCODER_FILE = "vocos_24khz.onnx";
export const ZIPVOICE_NUM_STEPS = 4;

const NUM_THREADS = 2;
/** 逐句合成上限：与 kokoro/matcha 同口径，批处理会把首句出声时间推迟到整批算完 */
const MAX_NUM_SENTENCES = 1;

export function zipvoiceModelDir(modelsDir: string): string {
  return join(modelsDir, SHERPA_SUBDIR, ZIPVOICE_DIR_NAME);
}

export function zipvoiceVocoderPath(modelsDir: string): string {
  return join(modelsDir, SHERPA_SUBDIR, "vocoders", ZIPVOICE_VOCODER_FILE);
}

export function zipvoiceRequiredFiles(dir: string, vocoder: string): readonly string[] {
  return [
    ...[ZIPVOICE_ENCODER_FILE, ZIPVOICE_DECODER_FILE, "espeak-ng-data", "lexicon.txt", "tokens.txt"].map((name) =>
      join(dir, name),
    ),
    vocoder,
  ];
}

function zipvoiceConfig(spec: ZipvoiceSpec): OfflineTtsConfig {
  return {
    model: {
      zipvoice: {
        encoder: join(spec.dir, ZIPVOICE_ENCODER_FILE),
        decoder: join(spec.dir, ZIPVOICE_DECODER_FILE),
        dataDir: join(spec.dir, "espeak-ng-data"),
        lexicon: join(spec.dir, "lexicon.txt"),
        tokens: join(spec.dir, "tokens.txt"),
        vocoder: spec.vocoder,
      },
    },
    numThreads: NUM_THREADS,
    maxNumSentences: MAX_NUM_SENTENCES,
  };
}

/** 模型句柄按目录缓存：分块合成复用同一份权重，不重复付加载开销 */
const handles = new Map<string, OfflineTtsInstance>();
/** 参考音频样本按路径缓存：同一角色的每个分块都带同一份参考，读盘解码不必重来 */
const waves = new Map<string, { samples: Float32Array; sampleRate: number }>();

async function loadHandle(spec: ZipvoiceSpec, sherpa: SherpaOnnxModule): Promise<OfflineTtsInstance> {
  const cached = handles.get(spec.dir);
  if (cached !== undefined) return cached;
  const handle = await withStderrMuted(() => sherpa.OfflineTts.createAsync(zipvoiceConfig(spec)));
  handles.set(spec.dir, handle);
  return handle;
}

function waveOf(path: string, sherpa: SherpaOnnxModule): { samples: Float32Array; sampleRate: number } {
  const cached = waves.get(path);
  if (cached !== undefined) return cached;
  const wave = sherpa.readWave(path);
  waves.set(path, wave);
  return wave;
}

async function loadBinding(): Promise<SherpaOnnxModule> {
  try {
    // 惰性加载：不点名角色嗓的调用不为绑定付解析与失败面
    const module = await import("sherpa-onnx-node");
    return module.default;
  } catch (error) {
    throw new EngineError(`sherpa-onnx-node 加载失败：${messageOf(error)}`);
  }
}

export async function synthesizeWithBinding(request: ZipvoiceSynthRequest): Promise<ZipvoiceSynthResult> {
  const sherpa = await loadBinding();
  try {
    const handle = await loadHandle(request.spec, sherpa);
    const wave = waveOf(request.referenceAudioPath, sherpa);
    // 克隆参数经 GenerationConfig 下发（sid 域不适用零样本克隆），distill 权重按 4 步流匹配
    const generation: GenerationConfigOptions = new sherpa.GenerationConfig({
      referenceAudio: wave.samples,
      referenceSampleRate: wave.sampleRate,
      referenceText: request.referenceText,
      numSteps: ZIPVOICE_NUM_STEPS,
    });
    const audio = await withStderrMuted(() =>
      handle.generateAsync({
        text: request.text,
        generationConfig: generation,
      }),
    );
    return { samples: audio.samples, sampleRate: audio.sampleRate };
  } catch (error) {
    if (error instanceof EngineError) throw error;
    throw new EngineError(`zipvoice 合成失败：${messageOf(error)}`);
  }
}