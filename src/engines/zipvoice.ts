import { EngineError, messageOf } from "../errors.ts";
import { defineExecutor } from "../executor.ts";
import type { Host } from "../host.ts";
import type { Availability, EngineAdapter, VoiceInfo } from "../types.ts";
import { cloneVoiceLanguage, resolveCharacterVoice, splitVoiceName, transcriptOf } from "../voices.ts";
import {
  zipvoiceModelDir,
  zipvoiceRequiredFiles,
  zipvoiceVocoderPath,
  type ZipvoiceSynth,
} from "./zipvoice-binding.ts";
import { wpmToSpeed } from "./sherpa.ts";

export { ZIPVOICE_DIR_NAME, ZIPVOICE_NUM_STEPS } from "./zipvoice-binding.ts";
export type { ZipvoiceSpec, ZipvoiceSynth, ZipvoiceSynthRequest, ZipvoiceSynthResult } from "./zipvoice-binding.ts";

/**
 * 音频能量校验：与 kokoro/matcha 同一道防线，量化权重或换版后的静音产出
 * 在样本层验不过就当合成失败交给回退层，不交付静音文件冒充成功。
 */
function assertAudible(samples: Float32Array): void {
  if (samples.length === 0) {
    throw new EngineError("zipvoice 返回空样本");
  }
  let peak = 0;
  let nanCount = 0;
  for (const sample of samples) {
    if (Number.isNaN(sample)) {
      nanCount++;
      continue;
    }
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }
  if (nanCount > 0) {
    throw new EngineError(`zipvoice 返回的样本含 ${nanCount} 个 NaN：权重与推理绑定不兼容`);
  }
  if (peak === 0) {
    throw new EngineError("zipvoice 合成结果没有任何音频能量");
  }
}

/** 目录报绝对路径、文件只报名字：与 sherpa 引擎同一报错口径，缺一个修一个太折磨 */
function missingAssetReason(dir: string, missing: readonly string[]): string {
  const names = missing.map((file) => file.slice(dir.length + 1));
  return `${dir} 缺少 ${names.length} 项：${names.join(", ")}`;
}

export interface ZipvoiceEngineOptions {
  host: Host;
  /** 模型缓存根目录（~/.cache/say/models），权重在其下的 sherpa/ 子目录 */
  modelsDir: string;
  /** 角色资产根目录（~/.local/share/say/voices），目录即注册表 */
  voicesDir: string;
  synth: ZipvoiceSynth;
}

/**
 * ZipVoice 零样本克隆适配：音色名是角色目录里的参考音频 + 逐字转写，
 * 模型权重全局一份（zh-en emilia distill int8），角色只是克隆参数。
 * 走 in-process 执行器：与 kokoro/matcha 同宿主同绑定，起子进程只会白付一次模型加载。
 */
export function createZipvoiceEngine(options: ZipvoiceEngineOptions): EngineAdapter {
  const { host, voicesDir, synth } = options;
  const modelDir = zipvoiceModelDir(options.modelsDir);
  const vocoder = zipvoiceVocoderPath(options.modelsDir);
  const requiredFiles = zipvoiceRequiredFiles(modelDir, vocoder);

  const missingFiles = (): string[] => requiredFiles.filter((file) => !host.fileExists(file));

  const requirementOf = async (voice: string | null) => {
    if (voice === null) {
      throw new EngineError("zipvoice 需要角色音色（-v <character>[-<variant>]），克隆嗓没有默认嗓");
    }
    return resolveCharacterVoice(host, voicesDir, voice);
  };

  const executor = defineExecutor("in-process", async (task) => {
    const requirement = await requirementOf(task.voice);
    const missing = missingFiles();
    if (missing.length > 0) {
      throw new EngineError(
        `角色 "${requirement.character}" 所需模型资产不完整：${missingAssetReason(modelDir, missing)}`,
      );
    }
    // 参考文本在这里读：剥离溯源注释后的正文才是克隆的参考文本，读取错误也在这里给出精确原因
    let referenceText: string;
    try {
      referenceText = transcriptOf(await host.readFileText(requirement.textPath));
    } catch (error) {
      if (error instanceof EngineError) throw error;
      throw new EngineError(`角色 "${requirement.character}" 的参考转写读取失败：${messageOf(error)}`);
    }
    // 加速请求不下发（native 绑定在 speed > 1 时挂起），但要明说而不是静默吞掉
    const speed = wpmToSpeed(task.rateWpm);
    if (speed > 1) {
      host.writeStderr(`say: 克隆嗓暂不支持加速语速，-r ${task.rateWpm} 被忽略（推理绑定在 speed > 1 时会挂起）\n`);
    }
    const result = await synth({
      spec: { dir: modelDir, vocoder },
      text: task.text,
      speed,
      referenceAudioPath: requirement.audioPath,
      referenceText,
    });
    assertAudible(result.samples);
    return { type: "pcm", samples: result.samples, sampleRate: result.sampleRate } as const;
  });

  /**
   * 角色目录在盘即认领名字（变体拼写一并认）——路由层据此把克隆嗓从
   * 「未知音色委派系统嗓」的旧语义里分出来。资产是否完整留给可用性/合成层报精确原因。
   */
  const ownsVoice = (name: string): boolean => splitVoiceName(host, voicesDir, name) !== null;

  const languageOf = (lang: string | null): VoiceInfo["lang"] => (lang === "en" || lang === "zh" ? lang : "multi");

  return {
    name: "zipvoice",
    // 进程内推理产出裸样本：分块每块都带同一份参考音频，可以拼也可以边合成边播
    chunkable: true,
    ownsVoice,
    async isAvailable(voice: string | null): Promise<Availability> {
      if (voice === null || !ownsVoice(voice)) {
        // 认不出的音色名不在可用性层判死：路由层不会把这类名字送过来，合成层兜底报精确原因
        return { ok: true };
      }
      const missing = missingFiles();
      if (missing.length > 0) {
        return { ok: false, reason: missingAssetReason(modelDir, missing) };
      }
      try {
        await requirementOf(voice);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: error instanceof EngineError ? error.message : String(error) };
      }
    },
    async listVoices(): Promise<VoiceInfo[]> {
      const voices: VoiceInfo[] = [];
      for (const character of host.listDirEntries(voicesDir)) {
        let meta: unknown;
        try {
          meta = JSON.parse(await host.readFileText(`${voicesDir}/${character}/meta.json`));
        } catch {
          // meta 缺失或损坏的角色进不了列表，但路由层仍认领该名字并报精确原因
          continue;
        }
        voices.push({ name: character, engine: "zipvoice", lang: languageOf(cloneVoiceLanguage(meta, null)) });
        for (const variant of variantNamesOf(meta)) {
          voices.push({
            name: `${character}-${variant}`,
            engine: "zipvoice",
            lang: languageOf(cloneVoiceLanguage(meta, variant)),
          });
        }
      }
      return voices;
    },
    speak: (text, opts) =>
      executor.synthesize({ text, voice: opts.voice, rateWpm: opts.rateWpm, output: opts.output }),
  };
}

function variantNamesOf(meta: unknown): readonly string[] {
  if (typeof meta !== "object" || meta === null) return [];
  const variants = (meta as Record<string, unknown>).variants;
  return typeof variants === "object" && variants !== null ? Object.keys(variants) : [];
}