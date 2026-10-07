import { fileURLToPath } from "node:url";
import { EngineError } from "../errors.ts";
import type { Host } from "../host.ts";
import type { Availability, EngineAdapter, SpeakOptions, VoiceInfo } from "../types.ts";
import { cloneVoiceLanguage, resolveCharacterVoice, splitVoiceName, type CloneVoiceSpec } from "../voices.ts";
import { wpmToSpeed } from "./sherpa.ts";
import { createShimSynth, type IndexttsLabSpec, type IndexttsSynth } from "./indextts-binding.ts";
import { detectTextLang } from "./gptsovits.ts";

export const INDEXTTS_ENGINE = "indextts";

/**
 * v2 一期 voice 关键字（config 层语义）在 IndexTTS 的落点：引擎仓自带示例音频。
 * IndexTTS 是零样本克隆引擎（无参考不出声），default 参考取引擎官方示例（随 repo 克隆分发，
 * 与引擎版本天然同步）；参考只供音色，发音语言由 lang 参数独立控制（zh/en 共用同一参考）。
 */
const DEFAULT_VOICE_KEY = "default";
const DEFAULT_VOICE_REPO_REL = "examples/voice_01.wav";

/**
 * venv 解释器三形态探测，与 scripts/lib/engine-status.mjs 的 venvPython 同构
 * （IndexTTS 走 uv sync 在仓库内自建 .venv）。spawn 与安装面判据共用这一个真源。
 */
export function resolveLabPython(labDir: string, host: Host): string {
  for (const rel of ["venv/bin/python", ".venv/bin/python", "index-tts/.venv/bin/python"]) {
    const path = `${labDir}/${rel}`;
    if (host.fileExists(path)) return path;
  }
  return `${labDir}/venv/bin/python`;
}

/**
 * 引擎安装面的文件判据，与 scripts/lib/engine-status.mjs 的 assessEngine 同构：
 * venv 解释器 + 仓库内核 + checkpoints 主权重九件 + default 参考音频。
 * auto 层（w2v-bert 等首跑自拉依赖）不在判据内——缺失不判 partial（状态查询的 autoPending 语义）。
 * 权重清单与 engine-manifest.mjs INDEXTTS.weights 手写同构，manifest 增删两处同改。
 */
export function indexttsMissingAssets(spec: IndexttsLabSpec, host: Host): string[] {
  const required = [
    spec.pythonPath,
    `${spec.repoDir}/indextts/infer_v2_5.py`,
    `${spec.modelsDir}/gpt.pth`,
    `${spec.modelsDir}/codec.pth`,
    `${spec.modelsDir}/s2mel.pth`,
    `${spec.modelsDir}/qwen0.6bemo4-merge/model.safetensors`,
    `${spec.modelsDir}/config.yaml`,
    `${spec.modelsDir}/feat1.pt`,
    `${spec.modelsDir}/feat2.pt`,
    `${spec.modelsDir}/wav2vec2bert_stats.pt`,
    `${spec.modelsDir}/multilingual_zh_ja_yue_char_del.tiktoken`,
    `${spec.repoDir}/${DEFAULT_VOICE_REPO_REL}`,
  ];
  return required.filter((path) => !host.fileExists(path));
}

function assertAudible(samples: Float32Array): void {
  if (samples.length === 0) {
    throw new EngineError("indextts 返回空样本");
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
    throw new EngineError(`indextts 返回的样本含 ${nanCount} 个 NaN：权重与推理绑定不兼容`);
  }
  if (peak === 0) {
    throw new EngineError("indextts 合成结果没有任何音频能量");
  }
}

export interface IndexttsEngineOptions {
  host: Host;
  /** say-lab 引擎目录（~/.local/share/say-lab/indextts） */
  labDir: string;
  /** 角色资产根目录（~/.local/share/say/voices），目录即注册表（与 gptsovits/zipvoice 同源） */
  voicesDir: string;
  /** shim 脚本路径；缺省按仓内 scripts/shims/ 定位，测试注入假路径 */
  shimPath?: string;
  /** 合成函数：缺省走真实 shim 会话，测试注入 fake */
  synth?: IndexttsSynth;
}

/**
 * IndexTTS 2.5 适配：infer() 整句形态（MPS 档），协议复用 S3 钉版。
 * 差异化能力是节奏控制——rateWpm 以时长倍率（duration_factor）透出，与语速倍率互为倒数；
 * emo_alpha 协议面预留（一期不发送：emo 参考链路合成耗时翻倍，默认情感面归试听简报后裁决）。
 * voice 语义：default = 引擎仓自带示例参考，角色嗓 = 角色目录 ref 一比一映射的零样本克隆。
 */
export function createIndexttsEngine(options: IndexttsEngineOptions): EngineAdapter {
  const { host, voicesDir } = options;
  const spec: IndexttsLabSpec = {
    labDir: options.labDir,
    repoDir: `${options.labDir}/index-tts`,
    modelsDir: `${options.labDir}/checkpoints`,
    pythonPath: resolveLabPython(options.labDir, host),
    shimPath: options.shimPath ?? fileURLToPath(new URL("../../scripts/shims/indextts-shim.py", import.meta.url)),
  };

  const synth = options.synth ?? createShimSynth(spec, host);

  /** default 嗓参考：引擎仓自带示例（随 repo 克隆分发） */
  const defaultRefPath = (): string => `${spec.repoDir}/${DEFAULT_VOICE_REPO_REL}`;

  /**
   * 角色 spec 的实例内 memo（S3 审查 F5/P2 收敛）：一次 CLI 调用里 isAvailable 与
   * speak 会先后解析同一角色，meta.json 双读双解析在此收成单次；失败不驻留，
   * 资产补齐后同进程重试可得。
   */
  const specCache = new Map<string, Promise<CloneVoiceSpec>>();
  const characterSpecOf = (voice: string): Promise<CloneVoiceSpec> => {
    const cached = specCache.get(voice);
    if (cached !== undefined) return cached;
    const parsed = resolveCharacterVoice(host, voicesDir, voice);
    specCache.set(voice, parsed);
    void parsed.catch(() => specCache.delete(voice));
    return parsed;
  };

  const requirementOf = async (voice: string | null): Promise<string> => {
    if (voice === null || voice === DEFAULT_VOICE_KEY) {
      return defaultRefPath();
    }
    const ref = splitVoiceName(host, voicesDir, voice);
    if (ref === null) {
      throw new EngineError(`indextts 未登记角色音色 "${voice}"（${voicesDir} 下没有对应角色目录）`);
    }
    // 转写不进协议（IndexTTS 从参考音频提取音色，无 prompt_text 参数），
    // 但资产完整性校验保留——ref 缺失的角色在这里得到能修的精确报错
    const requirement = await characterSpecOf(voice);
    return requirement.audioPath;
  };

  const ownsVoice = (name: string): boolean => splitVoiceName(host, voicesDir, name) !== null;

  const languageOf = (lang: string | null): VoiceInfo["lang"] => (lang === "en" || lang === "zh" ? lang : "multi");

  return {
    name: INDEXTTS_ENGINE,
    // 裸样本回传：块与块可拼接可流水，与 sherpa/zipvoice/gptsovits 同一 chunkable 语义
    chunkable: true,
    ownsVoice,
    async isAvailable(voice: string | null): Promise<Availability> {
      if (voice !== null && voice !== DEFAULT_VOICE_KEY && !ownsVoice(voice)) {
        // 认不出的音色名不在可用性层判死：路由层不会把这类名字送过来，合成层兜底报精确原因
        return { ok: true };
      }
      const missing = indexttsMissingAssets(spec, host);
      if (missing.length > 0) {
        const names = missing.map((file) => file.slice(spec.labDir.length + 1)).join(", ");
        return { ok: false, reason: `${spec.labDir} 缺少 ${missing.length} 项：${names}（先跑 scripts/install-engine.mjs indextts）` };
      }
      try {
        if (voice !== null && voice !== DEFAULT_VOICE_KEY) await characterSpecOf(voice);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: error instanceof EngineError ? error.message : String(error) };
      }
    },
    async listVoices(): Promise<VoiceInfo[]> {
      const voices: VoiceInfo[] = [{ name: DEFAULT_VOICE_KEY, engine: INDEXTTS_ENGINE, lang: "multi" }];
      for (const character of host.listDirEntries(voicesDir)) {
        let meta: unknown;
        try {
          meta = JSON.parse(await host.readFileText(`${voicesDir}/${character}/meta.json`));
        } catch {
          // meta 缺失或损坏的角色进不了列表，但路由层仍认领该名字并报精确原因
          continue;
        }
        voices.push({ name: character, engine: INDEXTTS_ENGINE, lang: languageOf(cloneVoiceLanguage(meta, null)) });
        const variants = (meta as { variants?: unknown }).variants;
        if (typeof variants === "object" && variants !== null) {
          for (const variant of Object.keys(variants as Record<string, unknown>)) {
            voices.push({
              name: `${character}-${variant}`,
              engine: INDEXTTS_ENGINE,
              lang: languageOf(cloneVoiceLanguage(meta, variant)),
            });
          }
        }
      }
      return voices;
    },
    async speak(text: string, opts: SpeakOptions) {
      const refAudioPath = await requirementOf(opts.voice);
      const result = await synth({
        text,
        refAudioPath,
        textLang: detectTextLang(text),
        // 时长倍率与 wpm 语速倍率互为倒数：wpmToSpeed 的 clamp [0.5,2] 取倒数后
        // 恰为 duration_factor 合法域 [0.5,2]，无需第二套 clamp 常量
        durationFactor: 1 / wpmToSpeed(opts.rateWpm),
      });
      assertAudible(result.samples);
      return { type: "pcm", samples: result.samples, sampleRate: result.sampleRate } as const;
    },
  };
}
