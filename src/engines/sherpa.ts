import { EngineError } from "../errors.ts";
import { defineExecutor } from "../executor.ts";
import type { Host } from "../host.ts";
import type { Availability, EngineAdapter, VoiceInfo } from "../types.ts";
import {
  kokoroModelDir,
  kokoroRequiredFiles,
  matchaModelDir,
  matchaRequiredFiles,
  vocoderPath,
  type SherpaModelSpec,
  type SherpaSynth,
} from "./sherpa-binding.ts";
import { KOKORO_VOICE_COUNT, KOKORO_VOICES, MATCHA_VOICES, kokoroSidOf, matchaSidOf, sherpaVoiceLang } from "./sherpa-voices.ts";

export type { SherpaModelSpec, SherpaSynth, SherpaSynthRequest, SherpaSynthResult } from "./sherpa-binding.ts";

/** 默认嗓。改这一处即可换默认音色，无需动配置默认值 */
export const DEFAULT_VOICE = "af_maple";

/**
 * wpm → speed 倍率的锚点与钳制区间。
 * 175 wpm 取自 macOS say 的默认语速（实测 `say x` 与 `say -r 175 x` 产物时长逐位相同），
 * 用户面的 -r 因此在两套引擎间保持同一口径。
 * 区间下界 0.5：再低会产出数十秒音频，一句话把终端堵住；上界 2.0：实测 ≥3 倍后时长不再缩短，只是音质崩塌。
 */
const RATE_ANCHOR_WPM = 175;
const MIN_SPEED = 0.5;
const MAX_SPEED = 2;

export function wpmToSpeed(rateWpm: number): number {
  const speed = rateWpm / RATE_ANCHOR_WPM;
  if (speed < MIN_SPEED) return MIN_SPEED;
  return speed > MAX_SPEED ? MAX_SPEED : speed;
}

/**
 * 音频能量校验。上游量化权重在本绑定下会返回长度正常、内容全 NaN 的样本，
 * 只看退出码与时长都会判成功，最终交付一个静音文件；
 * 因此出声与否必须在样本层验证，验不过就当合成失败交给回退层。
 */
function assertAudible(spec: SherpaModelSpec, samples: Float32Array): void {
  if (samples.length === 0) {
    throw new EngineError(`sherpa ${spec.kind} 返回空样本`);
  }
  let nanCount = 0;
  let peak = 0;
  for (const sample of samples) {
    if (Number.isNaN(sample)) {
      nanCount++;
      continue;
    }
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }
  if (nanCount === samples.length) {
    throw new EngineError(
      `sherpa ${spec.kind} 返回的样本全为 NaN：该权重与当前推理绑定不兼容，请改用 fp32 模型`,
    );
  }
  if (peak === 0) {
    throw new EngineError(`sherpa ${spec.kind} 合成结果没有任何音频能量`);
  }
}

/**
 * 说话人数交叉校验。内嵌音色表与权重换版错配时，越界 sid 不会报错而是静默落到 sid 0，
 * 表现为「能出声但是另一个嗓子」——比失败更难发现，所以在出声之前就把它判死。
 */
function assertSpeakerTable(spec: SherpaModelSpec, numSpeakers: number): void {
  const expected = spec.kind === "kokoro" ? KOKORO_VOICE_COUNT : 1;
  if (numSpeakers !== expected) {
    throw new EngineError(
      `sherpa ${spec.kind} 模型说话人数 ${numSpeakers} 与内嵌音色表条数 ${expected} 不符，资产可能已换版`,
    );
  }
}

export interface SherpaEngineOptions {
  host: Host;
  /** 模型缓存根目录（如 ~/.cache/say/models），sherpa 资产在其下的 sherpa/ 子目录 */
  modelsDir: string;
  synth: SherpaSynth;
}

/**
 * sherpa-onnx 进程内推理适配。走 in-process 执行器：绑定就是本进程里的函数调用，
 * 起子进程只会白付一次模型加载。
 */
export function createSherpaEngine(options: SherpaEngineOptions): EngineAdapter {
  const { host, modelsDir, synth } = options;
  const kokoroDir = kokoroModelDir(modelsDir);
  const matchaDir = matchaModelDir(modelsDir);
  const vocoder = vocoderPath(modelsDir);

  const kokoroReady = (): boolean => kokoroRequiredFiles(kokoroDir).every((file) => host.fileExists(file));
  const matchaReady = (): boolean => matchaRequiredFiles(matchaDir, vocoder).every((file) => host.fileExists(file));

  function specOf(voice: string): { spec: SherpaModelSpec; sid: number } {
    const kokoroSid = kokoroSidOf(voice);
    if (kokoroSid !== null) return { spec: { kind: "kokoro", dir: kokoroDir }, sid: kokoroSid };
    const matchaSid = matchaSidOf(voice);
    if (matchaSid !== null) {
      if (!matchaReady()) {
        throw new EngineError(`音色 "${voice}" 需要 matcha 资产，但 ${matchaDir} 不完整`);
      }
      return { spec: { kind: "matcha", dir: matchaDir, vocoder }, sid: matchaSid };
    }
    throw new EngineError(`sherpa 未登记音色 "${voice}"`);
  }

  const executor = defineExecutor("in-process", async (task) => {
    const voice = task.voice ?? DEFAULT_VOICE;
    const { spec, sid } = specOf(voice);
    const result = await synth({ spec, text: task.text, sid, speed: wpmToSpeed(task.rateWpm) });
    assertSpeakerTable(spec, result.numSpeakers);
    assertAudible(spec, result.samples);
    return { type: "pcm", samples: result.samples, sampleRate: result.sampleRate } as const;
  });

  return {
    name: "sherpa",
    async isAvailable(): Promise<Availability> {
      // 一次列全缺失项：只报第一个会让人修一个、再跑、再撞下一个，解包不全的模型目录尤其如此
      const missing = kokoroRequiredFiles(kokoroDir).filter((file) => !host.fileExists(file));
      return missing.length === 0 ? { ok: true } : { ok: false, reason: `缺少模型文件 ${missing.join(", ")}` };
    },
    async listVoices(): Promise<VoiceInfo[]> {
      const voices: VoiceInfo[] = [];
      if (kokoroReady()) {
        for (const name of KOKORO_VOICES) {
          voices.push({ name, engine: "sherpa", lang: sherpaVoiceLang(name) ?? "multi" });
        }
      }
      if (matchaReady()) {
        for (const voice of MATCHA_VOICES) {
          voices.push({ name: voice.name, engine: "sherpa", lang: sherpaVoiceLang(voice.name) ?? "zh" });
        }
      }
      return voices;
    },
    speak: (text, opts) =>
      executor.synthesize({ text, voice: opts.voice, rateWpm: opts.rateWpm, output: opts.output }),
  };
}
