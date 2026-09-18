// sherpa 引擎共享规格：zipvoice 参考口径（两通道同源）、Node 绑定各引擎配置工厂与必需清单。
// 本文件不触碰 native 绑定：worker（加载 .node）、node 适配器与 spawn 适配器共用同一份常量来源，
// 杜绝两通道口径漂移；可用性检查也不因导入本文件而在依赖未装的环境崩溃。
import path from "node:path";
import { KOKORO_DIR, MATCHA_DIR, VOCOS_22K, VOCOS_24K, ZIPVOICE_DIR } from "../assets.mjs";

export const NUM_THREADS = 2;

// zipvoice 官方包自带参考音频转写（test_wavs/prompt.txt 的 leijun-1.wav 行），原样采用
export const ZIPVOICE_REFERENCE_TEXT = "那还是36年前, 1987年. 我呢考上了武汉大学的计算机系.";
export const ZIPVOICE_REFERENCE_AUDIO = path.join(ZIPVOICE_DIR, "test_wavs", "leijun-1.wav");
// distill 版权重按官方示例用 4 步流匹配（默认 5 步面向非 distill）
export const ZIPVOICE_NUM_STEPS = 4;

/**
 * @typedef {Object} NodeEngineSpec
 * @property {string} engine raw-log engine 归属
 * @property {string} model raw-log model 字段
 * @property {string[]} required 必须在盘路径清单
 * @property {() => object} ttsConfig OfflineTts 构造参数（形状对齐 native 读取的键名）
 * @property {(sherpa: object) => object} generation 生成配置工厂（zipvoice 需经绑定 readWave 取参考音频样本）
 */

/** @type {Record<string, NodeEngineSpec>} */
export const NODE_ENGINE_SPECS = {
  kokoro: {
    engine: "sherpa-kokoro",
    model: "kokoro-int8-multi-lang-v1_1",
    required: [
      path.join(KOKORO_DIR, "model.int8.onnx"),
      path.join(KOKORO_DIR, "voices.bin"),
      path.join(KOKORO_DIR, "tokens.txt"),
      path.join(KOKORO_DIR, "espeak-ng-data"),
      path.join(KOKORO_DIR, "lexicon-us-en.txt"),
      path.join(KOKORO_DIR, "lexicon-zh.txt"),
      path.join(KOKORO_DIR, "date-zh.fst"),
      path.join(KOKORO_DIR, "number-zh.fst"),
    ],
    ttsConfig: () => ({
      model: {
        kokoro: {
          model: path.join(KOKORO_DIR, "model.int8.onnx"),
          voices: path.join(KOKORO_DIR, "voices.bin"),
          tokens: path.join(KOKORO_DIR, "tokens.txt"),
          dataDir: path.join(KOKORO_DIR, "espeak-ng-data"),
          lexicon: `${path.join(KOKORO_DIR, "lexicon-us-en.txt")},${path.join(KOKORO_DIR, "lexicon-zh.txt")}`,
        },
      },
      numThreads: NUM_THREADS,
      ruleFsts: `${path.join(KOKORO_DIR, "date-zh.fst")},${path.join(KOKORO_DIR, "number-zh.fst")}`,
    }),
    // v1_1 的 sid 映射与 v1_0 完全不同（0=af_maple），钉死 sid 保证四文本同音色可比
    generation: (sherpa) => new sherpa.GenerationConfig({ sid: 0, speed: 1.0 }),
  },
  matcha: {
    engine: "sherpa-matcha",
    model: "matcha-icefall-zh-baker",
    required: [
      path.join(MATCHA_DIR, "model-steps-3.onnx"),
      VOCOS_22K,
      path.join(MATCHA_DIR, "lexicon.txt"),
      path.join(MATCHA_DIR, "tokens.txt"),
      path.join(MATCHA_DIR, "dict"),
      path.join(MATCHA_DIR, "date.fst"),
      path.join(MATCHA_DIR, "number.fst"),
      path.join(MATCHA_DIR, "phone.fst"),
    ],
    ttsConfig: () => ({
      model: {
        matcha: {
          acousticModel: path.join(MATCHA_DIR, "model-steps-3.onnx"),
          vocoder: VOCOS_22K,
          lexicon: path.join(MATCHA_DIR, "lexicon.txt"),
          tokens: path.join(MATCHA_DIR, "tokens.txt"),
        },
      },
      numThreads: NUM_THREADS,
      ruleFsts: `${path.join(MATCHA_DIR, "date.fst")},${path.join(MATCHA_DIR, "number.fst")},${path.join(MATCHA_DIR, "phone.fst")}`,
    }),
    generation: (sherpa) => new sherpa.GenerationConfig({ sid: 0, speed: 1.0 }),
  },
  zipvoice: {
    engine: "sherpa-zipvoice",
    model: "zipvoice-distill-int8-zh-en-emilia",
    required: [
      path.join(ZIPVOICE_DIR, "encoder.int8.onnx"),
      path.join(ZIPVOICE_DIR, "decoder.int8.onnx"),
      path.join(ZIPVOICE_DIR, "espeak-ng-data"),
      path.join(ZIPVOICE_DIR, "lexicon.txt"),
      path.join(ZIPVOICE_DIR, "tokens.txt"),
      VOCOS_24K,
      ZIPVOICE_REFERENCE_AUDIO,
    ],
    ttsConfig: () => ({
      model: {
        zipvoice: {
          encoder: path.join(ZIPVOICE_DIR, "encoder.int8.onnx"),
          decoder: path.join(ZIPVOICE_DIR, "decoder.int8.onnx"),
          dataDir: path.join(ZIPVOICE_DIR, "espeak-ng-data"),
          lexicon: path.join(ZIPVOICE_DIR, "lexicon.txt"),
          tokens: path.join(ZIPVOICE_DIR, "tokens.txt"),
          vocoder: VOCOS_24K,
        },
      },
      numThreads: NUM_THREADS,
    }),
    generation: (sherpa) => {
      const wave = sherpa.readWave(ZIPVOICE_REFERENCE_AUDIO);
      return new sherpa.GenerationConfig({
        referenceAudio: wave.samples,
        referenceSampleRate: wave.sampleRate,
        referenceText: ZIPVOICE_REFERENCE_TEXT,
        numSteps: ZIPVOICE_NUM_STEPS,
      });
    },
  },
};
