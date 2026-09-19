// sherpa-onnx-node v1.13.8 未随包发布 .d.ts（仅 JSDoc types.js），此处按实际使用面手写最小声明。
// 只覆盖 bench 消费的 API；键名与形状经 node_modules 源码与 addon 二进制字符串实证。
declare module "sherpa-onnx-node" {
  /** 生成参数：sid/speed 走多说话人模型；zipvoice 走 referenceAudio/referenceText/numSteps */
  export class GenerationConfig {
    constructor(opts?: {
      silenceScale?: number;
      speed?: number;
      sid?: number;
      numSteps?: number;
      referenceAudio?: Float32Array;
      referenceSampleRate?: number;
      referenceText?: string;
      extra?: Record<string, number | string>;
    });
  }

  export interface GeneratedAudio {
    samples: Float32Array;
    sampleRate: number;
  }

  export interface TtsRequest {
    text: string;
    sid: number;
    speed: number;
    generationConfig?: GenerationConfig;
  }

  export class OfflineTts {
    constructor(config: object);
    generate(req: TtsRequest): GeneratedAudio;
    generateAsync(req: TtsRequest): Promise<GeneratedAudio>;
    // 1.13.8 未暴露 free/release，句柄随 GC/进程退出释放
  }

  export function readWave(file: string): GeneratedAudio;
  export function writeWave(file: string, audio: GeneratedAudio): void;

  const sherpa: {
    GenerationConfig: typeof GenerationConfig;
    OfflineTts: typeof OfflineTts;
    readWave: typeof readWave;
    writeWave: typeof writeWave;
  };
  export default sherpa;
}
