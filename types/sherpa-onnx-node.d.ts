/**
 * sherpa-onnx-node 的最小环境声明。包内不带 .d.ts，且它是 CJS 聚合导出：
 * 实测 `await import("sherpa-onnx-node")` 的命名导出为 undefined，全部成员挂在 default 上，
 * 所以这里只声明默认导出，不写 `export class` —— 那会让值导入通过类型检查却在运行时炸掉。
 * 只覆盖本仓实际用到的面，其余成员刻意不声明，用到时再补，避免声明与实现漂移无人察觉。
 */
declare module "sherpa-onnx-node" {
  export interface GeneratedAudio {
    readonly samples: Float32Array;
    readonly sampleRate: number;
  }

  export interface KokoroModelConfig {
    model: string;
    voices: string;
    tokens: string;
    /** espeak-ng 数据目录；与 lexicon 二选一，留空 lang 时必须给 lexicon */
    dataDir: string;
    /** 多份词典以逗号分隔，且必须是绝对路径：native 按字面路径查找，不以模型目录为基准 */
    lexicon: string;
  }

  export interface MatchaModelConfig {
    acousticModel: string;
    vocoder: string;
    lexicon: string;
    tokens: string;
  }

  export interface ZipvoiceModelConfig {
    encoder: string;
    decoder: string;
    tokens: string;
    lexicon: string;
    dataDir: string;
    /** vocos 24kHz：克隆链路专用，与 kokoro/matcha 的 22kHz vocoder 不通用 */
    vocoder: string;
  }

  export interface OfflineTtsModelConfig {
    kokoro?: KokoroModelConfig;
    matcha?: MatchaModelConfig;
    zipvoice?: ZipvoiceModelConfig;
    numThreads?: number;
    provider?: string;
    debug?: boolean;
  }

  export interface OfflineTtsConfig {
    model: OfflineTtsModelConfig;
    /** 包内 types.js 未列此键，native 实际接受；rule FST 负责数字与日期的读法展开 */
    ruleFsts?: string;
    maxNumSentences?: number;
    numThreads?: number;
  }

  export interface WaveObject {
    readonly samples: Float32Array;
    readonly sampleRate: number;
  }

  export interface GenerationConfigOptions {
    sid?: number;
    speed?: number;
    silenceScale?: number;
    /** 零样本克隆参数（ZipVoice）：参考音频样本、采样率与逐字转写必须配对给出 */
    referenceAudio?: Float32Array;
    referenceSampleRate?: number;
    referenceText?: string;
    /** 流匹配步数：distill 权重按官方示例用 4 步 */
    numSteps?: number;
  }

  export interface TtsRequest {
    text: string;
    generationConfig?: GenerationConfigOptions;
    onProgress?: (info: { samples: Float32Array; progress: number }) => number | boolean | void;
  }

  export interface OfflineTtsInstance {
    readonly numSpeakers: number;
    readonly sampleRate: number;
    generate(request: TtsRequest): GeneratedAudio;
    generateAsync(request: TtsRequest): Promise<GeneratedAudio>;
  }

  export interface OfflineTtsConstructor {
    new (config: OfflineTtsConfig): OfflineTtsInstance;
    createAsync(config: OfflineTtsConfig): Promise<OfflineTtsInstance>;
  }

  export interface SherpaOnnxModule {
    readonly OfflineTts: OfflineTtsConstructor;
    readonly GenerationConfig: new (options?: GenerationConfigOptions) => GenerationConfigOptions;
    /** 读 wav 为 float32 样本（-1..1）：零样本克隆的参考音频读取通道 */
    readWave(path: string): WaveObject;
    readonly version: string;
    readonly onnxruntimeVersion: string;
  }

  const sherpaOnnx: SherpaOnnxModule;
  export default sherpaOnnx;
}
