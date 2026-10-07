import { fileURLToPath } from "node:url";
import { EngineError } from "../errors.ts";
import type { Host } from "../host.ts";
import type { Availability, EngineAdapter, SpeakOptions, VoiceInfo } from "../types.ts";
import { cloneVoiceLanguage, resolveCharacterVoice, splitVoiceName, transcriptOf, type CloneVoiceSpec } from "../voices.ts";
import { createShimSynth, type FireredLabSpec, type FireredSynth } from "./firered-binding.ts";
import { detectTextLang } from "./gptsovits.ts";

export const FIRERED_ENGINE = "firered";

/**
 * default 嗓参考（S6）：FireRed 引擎无内置示例音频，取 v1 官方女声 prompt_2
 * （install-engine 经 manifest prompts/ 条目分发；调研 zh_clone 样音即此参考产出）。
 * zh/en 克隆共用同一参考，发音语言由 language 独立控制（与 IndexTTS 同语义）；
 * 转写钉死为常量——参考与转写必须严格对应，二者同源分发才不会漂移。
 */
const DEFAULT_VOICE_KEY = "default";
const DEFAULT_VOICE_REL = "prompts/prompt_2.wav";
const DEFAULT_PROMPT_TEXT = "对，所以说你现在的话，这个账单的话，你既然说能处理，那你就想办法处理掉。";

/**
 * venv 解释器探测，与 scripts/lib/engine-status.mjs 的 venvPython 同构
 * （firered 走 uv venv 落 labDir/venv）。spawn 与安装面判据共用这一个真源。
 */
export function resolveLabPython(labDir: string, host: Host): string {
  for (const rel of ["venv/bin/python", ".venv/bin/python", "FireRedTTS3/.venv/bin/python"]) {
    const path = `${labDir}/${rel}`;
    if (host.fileExists(path)) return path;
  }
  return `${labDir}/venv/bin/python`;
}

/**
 * 引擎安装面的文件判据，与 scripts/lib/engine-status.mjs 的 assessEngine 同构：
 * venv 解释器 + 仓库内核 + weights 十件 + default 参考。
 * 权重清单与 engine-manifest.mjs FIRERED.weights 手写同构，manifest 增删两处同改。
 */
export function fireredMissingAssets(spec: FireredLabSpec, host: Host): string[] {
  const required = [
    spec.pythonPath,
    `${spec.repoDir}/fireredtts3/core.py`,
    `${spec.modelsDir}/fireredtts3_base/model.safetensors`,
    `${spec.modelsDir}/fireredtts3_base/config.json`,
    `${spec.modelsDir}/fireredtts3_instruct/model.safetensors`,
    `${spec.modelsDir}/fireredtts3_instruct/config.json`,
    `${spec.modelsDir}/redae/model.safetensors`,
    `${spec.modelsDir}/redae/config.json`,
    `${spec.modelsDir}/campp/campplus_voxceleb.bin`,
    `${spec.modelsDir}/text_tokenizer/tokenizer.json`,
    `${spec.modelsDir}/text_tokenizer/tokenizer_config.json`,
    `${spec.modelsDir}/text_tokenizer/vocab.json`,
    `${spec.labDir}/${DEFAULT_VOICE_REL}`,
  ];
  return required.filter((path) => !host.fileExists(path));
}

function assertAudible(samples: Float32Array): void {
  if (samples.length === 0) {
    throw new EngineError("firered 返回空样本");
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
    throw new EngineError(`firered 返回的样本含 ${nanCount} 个 NaN：权重与推理绑定不兼容`);
  }
  if (peak === 0) {
    throw new EngineError("firered 合成结果没有任何音频能量");
  }
}

export interface FireredEngineOptions {
  host: Host;
  /** say-lab 引擎目录（~/.local/share/say-lab/firered） */
  labDir: string;
  /** 角色资产根目录（~/.local/share/say/voices），目录即注册表（与 gptsovits/zipvoice 同源） */
  voicesDir: string;
  /** shim 脚本路径；缺省按仓内 scripts/shims/ 定位，测试注入假路径 */
  shimPath?: string;
  /** 合成函数：缺省走真实 shim 会话，测试注入 fake */
  synth?: FireredSynth;
}

/**
 * FireRedTTS3 适配：generate() 整句形态（MPS 档），协议复用 S3 钉版。
 * 克隆走 Base 类——Instruct 的 generate_tts 有上游解包 bug（backend 2 元组被按
 * 3 元组解包必崩），shim 不 import Instruct 类规避；指令控制面（语速/pitch/volume、
 * voice_design）属 Instruct 能力，一期不接。语速同理不透出（Base.generate 无语速参数，
 * rateWpm 忽略——FireRed 的差异化在 24 语言与方言面，非节奏控制）。
 * voice 语义：default = v1 官方参考（manifest 分发），角色嗓 = 角色目录 ref 一比一映射。
 */
export function createFireredEngine(options: FireredEngineOptions): EngineAdapter {
  const { host, voicesDir } = options;
  const spec: FireredLabSpec = {
    labDir: options.labDir,
    repoDir: `${options.labDir}/FireRedTTS3`,
    modelsDir: `${options.labDir}/models/FireRedTTS3`,
    pythonPath: resolveLabPython(options.labDir, host),
    shimPath: options.shimPath ?? fileURLToPath(new URL("../../scripts/shims/firered-shim.py", import.meta.url)),
  };

  const synth = options.synth ?? createShimSynth(spec, host);

  /** default 嗓参考：v1 官方 prompt_2（manifest prompts/ 条目分发），转写与音频同源钉死 */
  const defaultRequirement = (): { audioPath: string; promptText: string } => ({
    audioPath: `${spec.labDir}/${DEFAULT_VOICE_REL}`,
    promptText: DEFAULT_PROMPT_TEXT,
  });

  /**
   * 角色 spec 的实例内 memo（S3 审查 F5/P2 收敛）：一次 CLI 调用里 isAvailable 与
   * speak 会先后解析同一角色，meta.json 双读双解析在此收成单次；失败不驻留，
   * 资产补齐后同进程重试可得。default 走常量面不进缓存。
   */
  const specCache = new Map<string, Promise<CloneVoiceSpec>>();
  const characterSpecOf = (voice: string): Promise<CloneVoiceSpec> => {
    const cached = specCache.get(voice);
    if (cached !== undefined) return cached;
    const spec = resolveCharacterVoice(host, voicesDir, voice);
    specCache.set(voice, spec);
    void spec.catch(() => specCache.delete(voice));
    return spec;
  };

  const requirementOf = async (voice: string | null): Promise<{ audioPath: string; promptText: string }> => {
    if (voice === null || voice === DEFAULT_VOICE_KEY) {
      return defaultRequirement();
    }
    const ref = splitVoiceName(host, voicesDir, voice);
    if (ref === null) {
      throw new EngineError(`firered 未登记角色音色 "${voice}"（${voicesDir} 下没有对应角色目录）`);
    }
    // FireRed 克隆必带参考转写（协议 prompt_text）：ref.txt 剥溯源注释后下传
    const requirement = await characterSpecOf(voice);
    return { audioPath: requirement.audioPath, promptText: transcriptOf(await host.readFileText(requirement.textPath)) };
  };

  const ownsVoice = (name: string): boolean => splitVoiceName(host, voicesDir, name) !== null;

  const languageOf = (lang: string | null): VoiceInfo["lang"] => (lang === "en" || lang === "zh" ? lang : "multi");

  return {
    name: FIRERED_ENGINE,
    // 裸样本回传：块与块可拼接可流水，与 sherpa/zipvoice/gptsovits 同一 chunkable 语义
    chunkable: true,
    ownsVoice,
    async isAvailable(voice: string | null): Promise<Availability> {
      if (voice !== null && voice !== DEFAULT_VOICE_KEY && !ownsVoice(voice)) {
        // 认不出的音色名不在可用性层判死：路由层不会把这类名字送过来，合成层兜底报精确原因
        return { ok: true };
      }
      const missing = fireredMissingAssets(spec, host);
      if (missing.length > 0) {
        const names = missing.map((file) => file.slice(spec.labDir.length + 1)).join(", ");
        return { ok: false, reason: `${spec.labDir} 缺少 ${missing.length} 项：${names}（先跑 scripts/install-engine.mjs firered）` };
      }
      try {
        if (voice !== null && voice !== DEFAULT_VOICE_KEY) await characterSpecOf(voice);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: error instanceof EngineError ? error.message : String(error) };
      }
    },
    async listVoices(): Promise<VoiceInfo[]> {
      const voices: VoiceInfo[] = [{ name: DEFAULT_VOICE_KEY, engine: FIRERED_ENGINE, lang: "multi" }];
      for (const character of host.listDirEntries(voicesDir)) {
        let meta: unknown;
        try {
          meta = JSON.parse(await host.readFileText(`${voicesDir}/${character}/meta.json`));
        } catch {
          // meta 缺失或损坏的角色进不了列表，但路由层仍认领该名字并报精确原因
          continue;
        }
        voices.push({ name: character, engine: FIRERED_ENGINE, lang: languageOf(cloneVoiceLanguage(meta, null)) });
        const variants = (meta as { variants?: unknown }).variants;
        if (typeof variants === "object" && variants !== null) {
          for (const variant of Object.keys(variants as Record<string, unknown>)) {
            voices.push({
              name: `${character}-${variant}`,
              engine: FIRERED_ENGINE,
              lang: languageOf(cloneVoiceLanguage(meta, variant)),
            });
          }
        }
      }
      return voices;
    },
    async speak(text: string, opts: SpeakOptions) {
      const requirement = await requirementOf(opts.voice);
      const result = await synth({
        text,
        refAudioPath: requirement.audioPath,
        promptText: requirement.promptText,
        textLang: detectTextLang(text),
      });
      assertAudible(result.samples);
      return { type: "pcm", samples: result.samples, sampleRate: result.sampleRate } as const;
    },
  };
}
