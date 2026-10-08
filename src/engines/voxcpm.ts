import { fileURLToPath } from "node:url";
import { daemonForEngine, type DaemonEngineSettings } from "../config.ts";
import { EngineError, messageOf } from "../errors.ts";
import type { Host } from "../host.ts";
import type { AudioOut, Availability, EngineAdapter, SpeakOptions, VoiceInfo } from "../types.ts";
import { concatSamples } from "../wav.ts";
import { cloneVoiceLanguage, resolveCharacterVoice, splitVoiceName, transcriptOf } from "../voices.ts";
import { createShimStreamSynth, createVoxcpmSynth, type VoxcpmDaemonTuning, type VoxcpmLabSpec, type VoxcpmStreamSynth } from "./voxcpm-binding.ts";

export const VOXCPM_ENGINE = "voxcpm";

/**
 * v2 一期 voice 关键字（config 层语义）在 VoxCPM 的落点是 voice creation 模式：
 * 引擎支持无参考合成——纯文本描述造音色（control 指令形态，括号前缀内联 text 首部），
 * voice=null 或 "default" 时用内置中性描述；这是协议 control 字段的首个消费方。
 * 描述文案决定 default 嗓听感，S8 试听简报可调（见决策台账 D5）。
 */
const DEFAULT_VOICE_KEY = "default";
const DEFAULT_VOICE_CONTROL = "A clear and natural voice, speaking at a calm and steady pace";

/**
 * venv 解释器三形态探测，与 scripts/lib/engine-status.mjs 的 venvPython 同构
 * （提取到 shim-session 时的 gptsovits 同款判据：venv/、.venv/、仓库内 .venv/）。
 * spawn 与安装面判据共用这一个真源，判据漂移无从发生。
 */
export function resolveLabPython(labDir: string, host: Host): string {
  for (const rel of ["venv/bin/python", ".venv/bin/python", "VoxCPM/.venv/bin/python"]) {
    const path = `${labDir}/${rel}`;
    if (host.fileExists(path)) return path;
  }
  return `${labDir}/venv/bin/python`;
}

/**
 * 引擎安装面的文件判据，与 scripts/lib/engine-status.mjs 的 assessEngine 同构：
 * venv 解释器 + models/ 七件资产（engine-manifest.mjs VOXCPM.weights 的落位清单，
 * 此处手写会漂移——manifest 增删权重两处同改）。权重为单文件形态无 archive marker。
 */
export function voxcpmMissingAssets(spec: VoxcpmLabSpec, host: Host): string[] {
  const required = [
    spec.pythonPath,
    `${spec.modelsDir}/model.safetensors`,
    `${spec.modelsDir}/audiovae.pth`,
    `${spec.modelsDir}/config.json`,
    `${spec.modelsDir}/tokenizer.json`,
    `${spec.modelsDir}/tokenizer_config.json`,
    `${spec.modelsDir}/special_tokens_map.json`,
    `${spec.modelsDir}/tokenization_voxcpm2.py`,
  ];
  return required.filter((path) => !host.fileExists(path));
}

/** 流式块的轻量校验：NaN 只可能是权重/推理栈坏了，任何块出现都按失败收敛（块级能量不作流式判据——间隙零样本是合法形态） */
function assertNoNaN(samples: Float32Array): void {
  let nanCount = 0;
  for (const sample of samples) {
    if (Number.isNaN(sample)) nanCount++;
  }
  if (nanCount > 0) {
    throw new EngineError(`voxcpm 返回的样本含 ${nanCount} 个 NaN：权重与推理绑定不兼容`);
  }
}

function assertAudible(samples: Float32Array): void {
  if (samples.length === 0) {
    throw new EngineError("voxcpm 返回空样本");
  }
  assertNoNaN(samples);
  let peak = 0;
  for (const sample of samples) {
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }
  if (peak === 0) {
    throw new EngineError("voxcpm 合成结果没有任何音频能量");
  }
}

export interface VoxcpmEngineOptions {
  host: Host;
  /** say-lab 引擎目录（~/.local/share/say-lab/voxcpm） */
  labDir: string;
  /** 角色资产根目录（~/.local/share/say/voices），目录即注册表（与 gptsovits/zipvoice 同源） */
  voicesDir: string;
  /** shim 脚本路径；缺省按仓内 scripts/shims/ 定位，测试注入假路径 */
  shimPath?: string;
  /** 流式合成函数：缺省走真实 shim 会话，测试注入 fake */
  synth?: VoxcpmStreamSynth;
  /** daemon 计时旋钮覆写（热启动）：真机走缺省，测试收窗与缩短收割窗口 */
  daemon?: VoxcpmDaemonTuning;
  /** 接线层（main）注入的三层解析投影；缺省 env-only 回退——与 daemon 上线前接线等价 */
  daemonSettings?: DaemonEngineSettings;
}

/**
 * VoxCPM2 适配：generate_streaming 流式内核（MPS 档），协议复用 S3 钉版。
 * voice 语义：default = voice creation（内置描述 control 前缀，无参考），
 * 角色嗓 = 角色目录 ref 一比一映射的零样本克隆（prompt_wav/prompt_text 引擎强制成对）。
 * VoxCPM 无数值语速参数（唯一节奏形态是自然语言指令），rateWpm 一期不做映射。
 */
export function createVoxcpmEngine(options: VoxcpmEngineOptions): EngineAdapter {
  const { host, voicesDir } = options;
  const spec: VoxcpmLabSpec = {
    labDir: options.labDir,
    modelsDir: `${options.labDir}/models`,
    pythonPath: resolveLabPython(options.labDir, host),
    shimPath: options.shimPath ?? fileURLToPath(new URL("../../scripts/shims/voxcpm-shim.py", import.meta.url)),
  };

  // 逃生门在装配点落闸：off 直连 per-call 管道，合成面退回 daemon 上线前的单形态——
  // 门是形态选择，不是失败降级。三层输入（内置 < config < env）：接线层注入 daemonSettings，
  // 测试与直接装配走 env-only 回退
  const gate =
    options.daemonSettings ??
    (() => {
      const r = daemonForEngine({ env: host.env, file: null, engine: VOXCPM_ENGINE });
      for (const w of r.warnings) host.writeStderr(`${w}\n`);
      return { enabled: r.enabled, idleMinutes: r.idleMinutes };
    })();
  const streamSynth =
    options.synth ??
    (gate.enabled ? createVoxcpmSynth(spec, host, { ...options.daemon, idleMinutes: options.daemon?.idleMinutes ?? gate.idleMinutes }) : createShimStreamSynth(spec, host));

  /** 一次合成的请求前置形态：default 走 voice creation，角色走零样本克隆 */
  const requirementOf = async (voice: string | null): Promise<{ refAudioPath: string | null; promptText: string | null; control: string | null }> => {
    if (voice === null || voice === DEFAULT_VOICE_KEY) {
      return { refAudioPath: null, promptText: null, control: DEFAULT_VOICE_CONTROL };
    }
    const ref = splitVoiceName(host, voicesDir, voice);
    if (ref === null) {
      throw new EngineError(`voxcpm 未登记角色音色 "${voice}"（${voicesDir} 下没有对应角色目录）`);
    }
    const requirement = await resolveCharacterVoice(host, voicesDir, voice);
    let promptText: string;
    try {
      promptText = transcriptOf(await host.readFileText(requirement.textPath));
    } catch (error) {
      if (error instanceof EngineError) throw error;
      throw new EngineError(`角色 "${ref.character}" 的参考转写读取失败：${messageOf(error)}`);
    }
    return { refAudioPath: requirement.audioPath, promptText, control: null };
  };

  const ownsVoice = (name: string): boolean => splitVoiceName(host, voicesDir, name) !== null;

  const languageOf = (lang: string | null): VoiceInfo["lang"] => (lang === "en" || lang === "zh" || lang === "ja" ? lang : "multi");

  const buildStream = async function* (text: string, opts: SpeakOptions): AsyncGenerator<Extract<AudioOut, { type: "pcm" }>> {
    const requirement = await requirementOf(opts.voice);
    for await (const chunk of streamSynth({
      text,
      refAudioPath: requirement.refAudioPath,
      promptText: requirement.promptText,
      control: requirement.control,
    })) {
      assertNoNaN(chunk.samples);
      yield { type: "pcm", samples: chunk.samples, sampleRate: chunk.sampleRate };
    }
  };

  return {
    name: VOXCPM_ENGINE,
    // 裸样本回传：块与块可拼接可流水，与 sherpa/zipvoice/gptsovits 同一 chunkable 语义
    chunkable: true,
    speakStreaming: (text, opts) => buildStream(text, opts),
    ownsVoice,
    async isAvailable(voice: string | null): Promise<Availability> {
      if (voice !== null && voice !== DEFAULT_VOICE_KEY && !ownsVoice(voice)) {
        // 认不出的音色名不在可用性层判死：路由层不会把这类名字送过来，合成层兜底报精确原因
        return { ok: true };
      }
      const missing = voxcpmMissingAssets(spec, host);
      if (missing.length > 0) {
        const names = missing.map((file) => file.slice(spec.labDir.length + 1)).join(", ");
        return { ok: false, reason: `${spec.labDir} 缺少 ${missing.length} 项：${names}（先跑 scripts/install-engine.mjs voxcpm）` };
      }
      try {
        if (voice !== null && voice !== DEFAULT_VOICE_KEY) await resolveCharacterVoice(host, voicesDir, voice);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: error instanceof EngineError ? error.message : String(error) };
      }
    },
    async listVoices(): Promise<VoiceInfo[]> {
      const voices: VoiceInfo[] = [{ name: DEFAULT_VOICE_KEY, engine: VOXCPM_ENGINE, lang: "multi" }];
      for (const character of host.listDirEntries(voicesDir)) {
        let meta: unknown;
        try {
          meta = JSON.parse(await host.readFileText(`${voicesDir}/${character}/meta.json`));
        } catch {
          // meta 缺失或损坏的角色进不了列表，但路由层仍认领该名字并报精确原因
          continue;
        }
        voices.push({ name: character, engine: VOXCPM_ENGINE, lang: languageOf(cloneVoiceLanguage(meta, null)) });
        const variants = (meta as { variants?: unknown }).variants;
        if (typeof variants === "object" && variants !== null) {
          for (const variant of Object.keys(variants as Record<string, unknown>)) {
            voices.push({
              name: `${character}-${variant}`,
              engine: VOXCPM_ENGINE,
              lang: languageOf(cloneVoiceLanguage(meta, variant)),
            });
          }
        }
      }
      return voices;
    },
    // 落盘/整句形态：流式收集到终结再拼接（交付物语义要求完整音频）
    async speak(text: string, opts: SpeakOptions) {
      const chunks: Float32Array[] = [];
      let sampleRate = 0;
      for await (const out of buildStream(text, opts)) {
        if (chunks.length > 0 && out.sampleRate !== sampleRate) {
          throw new EngineError(`块间采样率不一致（${sampleRate} 与 ${out.sampleRate}），拼接会变调`);
        }
        sampleRate = out.sampleRate;
        chunks.push(out.samples);
      }
      const samples = concatSamples(chunks);
      assertAudible(samples);
      return { type: "pcm", samples, sampleRate } as const;
    },
  };
}
