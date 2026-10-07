import { fileURLToPath } from "node:url";
import { EngineError, messageOf } from "../errors.ts";
import type { Host } from "../host.ts";
import type { Availability, EngineAdapter, SpeakOptions, VoiceInfo } from "../types.ts";
import { cloneVoiceLanguage, resolveCharacterVoice, splitVoiceName, transcriptOf } from "../voices.ts";
import { wpmToSpeed } from "./sherpa.ts";
import { createShimSynth, type GptsovitsLabSpec, type GptsovitsSynth } from "./gptsovits-binding.ts";

export const GPTSOVITS_ENGINE = "gptsovits";

/**
 * v2 一期 voice 关键字（config 层语义）与引擎默认嗓共用"default"这个名字：
 * GPT-SoVITS 没有无参考合成，零样本必须带参考音频——引擎内置一对中性参考
 * （zh/en 各一段，随仓 assets 入仓），voice=null 或 "default" 时按文本语言选取。
 * locale 预设到引擎嗓的最终映射归 S8，这里先给自足落点。
 */
const DEFAULT_VOICE_KEY = "default";

/** 文本语言 heuristic 的判定线：中文字符占字母级字符的比例，zh/en 双参考的最简分界 */
const ZH_RATIO_THRESHOLD = 0.3;

/**
 * 文本语言判定（zh/en），default 参考选择与请求的 text_lang 共用同一真源：
 * 引擎侧 auto 检测对短中文文本会误判 ja（fast_langdetect 的汉字共享缺陷，实测坐实），
 * 误判的结局是日文音素读中文——参考音频只有 zh/en 时这类语种面本就该由消费方钉死。
 * 纯标点/数字文本归 zh（中文底线是 D10 修订后的默认体验）。
 */
export function detectTextLang(text: string): "zh" | "en" {
  const zhChars = (text.match(/[一-鿿]/g) ?? []).length;
  const latinChars = (text.match(/[A-Za-z]/g) ?? []).length;
  if (zhChars === 0) return latinChars > 0 ? "en" : "zh";
  return zhChars / (zhChars + latinChars) >= ZH_RATIO_THRESHOLD ? "zh" : "en";
}

export interface GptsovitsEngineOptions {
  host: Host;
  /** say-lab 引擎目录（~/.local/share/say-lab/gptsovits） */
  labDir: string;
  /** 角色资产根目录（~/.local/share/say/voices），目录即注册表（与 zipvoice 同源） */
  voicesDir: string;
  /** 内置中性参考目录；缺省按仓内 assets/ 定位，测试注入假路径 */
  defaultVoiceDir?: string;
  /** shim 脚本路径；缺省按仓内 scripts/shims/ 定位 */
  shimPath?: string;
  /** 合成函数：缺省走真实 shim 会话，测试注入 fake */
  synth?: GptsovitsSynth;
}

/**
 * venv 解释器的三形态探测，与 scripts/lib/engine-status.mjs 的 venvPython 同构：
 * 标准位 venv/、uv sync 落点 .venv/、装进仓库的 GPT-SoVITS/.venv/。
 * spawn 与安装面判据共用这一个真源，判据漂移无从发生。
 */
export function resolveLabPython(labDir: string, host: Host): string {
  for (const rel of ["venv/bin/python", ".venv/bin/python", "GPT-SoVITS/.venv/bin/python"]) {
    const path = `${labDir}/${rel}`;
    if (host.fileExists(path)) return path;
  }
  return `${labDir}/venv/bin/python`;
}

/**
 * 引擎安装面的文件判据，与 scripts/lib/engine-status.mjs 的 assessEngine 同构：
 * venv 解释器（spec.pythonPath 已按三形态探测）+ 仓库内核 + 两份解压资产 + open_jtalk 字典
 * （archive 形态须 .install-ok 完成标记，目录存在只说明解压开始过）。判据漂移两处同改。
 */
export function gptsovitsMissingAssets(spec: GptsovitsLabSpec, host: Host): string[] {
  const required = [
    spec.pythonPath,
    `${spec.repoDir}/GPT_SoVITS/TTS_infer_pack/TTS.py`,
    `${spec.repoDir}/GPT_SoVITS/pretrained_models/.install-ok`,
    `${spec.repoDir}/GPT_SoVITS/text/G2PWModel/.install-ok`,
    `${spec.labDir}/open_jtalk_dic_utf_8-1.11/.install-ok`,
  ];
  return required.filter((path) => !host.fileExists(path));
}

/** 一次合成的参考参数（协议字段的一比一前置形态） */
interface RefRequirement {
  refAudioPath: string;
  promptText: string;
  promptLang: string;
}

function assertAudible(samples: Float32Array): void {
  if (samples.length === 0) {
    throw new EngineError("gptsovits 返回空样本");
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
    throw new EngineError(`gptsovits 返回的样本含 ${nanCount} 个 NaN：权重与推理绑定不兼容`);
  }
  if (peak === 0) {
    throw new EngineError("gptsovits 合成结果没有任何音频能量");
  }
}

/**
 * GPT-SoVITS v2 适配：api_v2 同核薄封装（CPU 档），零样本克隆——
 * 每请求自带参考（角色目录一比一映射或内置中性参考），引擎侧无角色状态。
 * 进程形态是 per-call 常驻：引擎实例内多次合成复用同一 shim 进程（首块付冷启动，后续热态）。
 */
export function createGptsovitsEngine(options: GptsovitsEngineOptions): EngineAdapter {
  const { host, voicesDir } = options;
  const spec: GptsovitsLabSpec = {
    labDir: options.labDir,
    repoDir: `${options.labDir}/GPT-SoVITS`,
    pythonPath: resolveLabPython(options.labDir, host),
    shimPath: options.shimPath ?? fileURLToPath(new URL("../../scripts/shims/gptsovits-shim.py", import.meta.url)),
  };
  const defaultVoiceDir = options.defaultVoiceDir ?? fileURLToPath(new URL("../../assets/engines/gptsovits", import.meta.url));

  const synth = options.synth ?? createShimSynth(spec, host);

  /** default 嗓参考对：wav 与配套 txt（转写必须与音频内容严格对应，同角色目录的 ref 语义） */
  const defaultRequirement = async (lang: "zh" | "en"): Promise<RefRequirement> => {
    const audioPath = `${defaultVoiceDir}/default-${lang}.wav`;
    const textPath = `${defaultVoiceDir}/default-${lang}.txt`;
    if (!host.fileExists(audioPath) || !host.fileExists(textPath)) {
      throw new EngineError(`gptsovits 内置 default 参考（${lang}）资产缺失：${defaultVoiceDir} 下应有 default-${lang}.wav 与 .txt`);
    }
    return {
      refAudioPath: audioPath,
      promptText: transcriptOf(await host.readFileText(textPath)),
      promptLang: lang,
    };
  };

  const characterRequirement = async (voice: string): Promise<RefRequirement> => {
    const ref = splitVoiceName(host, voicesDir, voice);
    if (ref === null) {
      throw new EngineError(`gptsovits 未登记角色音色 "${voice}"（${voicesDir} 下没有对应角色目录）`);
    }
    const requirement = await resolveCharacterVoice(host, voicesDir, voice);
    let meta: unknown;
    try {
      meta = JSON.parse(await host.readFileText(`${voicesDir}/${ref.character}/meta.json`));
    } catch (error) {
      throw new EngineError(`角色 "${ref.character}" 的 meta.json 读取失败：${messageOf(error)}`);
    }
    let promptText: string;
    try {
      promptText = transcriptOf(await host.readFileText(requirement.textPath));
    } catch (error) {
      if (error instanceof EngineError) throw error;
      throw new EngineError(`角色 "${ref.character}" 的参考转写读取失败：${messageOf(error)}`);
    }
    return {
      refAudioPath: requirement.audioPath,
      promptText,
      promptLang: cloneVoiceLanguage(meta, ref.variant) ?? "zh",
    };
  };

  const ownsVoice = (name: string): boolean => splitVoiceName(host, voicesDir, name) !== null;

  const languageOf = (lang: string | null): VoiceInfo["lang"] => (lang === "en" || lang === "zh" ? lang : "multi");

  return {
    name: GPTSOVITS_ENGINE,
    // 裸样本回传：块与块可拼接可流水，与 sherpa/zipvoice 同一 chunkable 语义
    chunkable: true,
    ownsVoice,
    async isAvailable(voice: string | null): Promise<Availability> {
      if (voice !== null && voice !== DEFAULT_VOICE_KEY && !ownsVoice(voice)) {
        // 认不出的音色名不在可用性层判死：路由层不会把这类名字送过来，合成层兜底报精确原因
        return { ok: true };
      }
      const missing = gptsovitsMissingAssets(spec, host);
      if (missing.length > 0) {
        const names = missing.map((file) => file.slice(spec.labDir.length + 1)).join(", ");
        return { ok: false, reason: `${spec.labDir} 缺少 ${names.length} 项：${names}（先跑 scripts/install-engine.mjs gptsovits）` };
      }
      try {
        if (voice === null || voice === DEFAULT_VOICE_KEY) {
          await defaultRequirement("zh");
          await defaultRequirement("en");
          return { ok: true };
        }
        await characterRequirement(voice);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: error instanceof EngineError ? error.message : String(error) };
      }
    },
    async listVoices(): Promise<VoiceInfo[]> {
      const voices: VoiceInfo[] = [{ name: DEFAULT_VOICE_KEY, engine: GPTSOVITS_ENGINE, lang: "multi" }];
      for (const character of host.listDirEntries(voicesDir)) {
        let meta: unknown;
        try {
          meta = JSON.parse(await host.readFileText(`${voicesDir}/${character}/meta.json`));
        } catch {
          // meta 缺失或损坏的角色进不了列表，但路由层仍认领该名字并报精确原因
          continue;
        }
        voices.push({ name: character, engine: GPTSOVITS_ENGINE, lang: languageOf(cloneVoiceLanguage(meta, null)) });
        const variants = (meta as { variants?: unknown }).variants;
        if (typeof variants === "object" && variants !== null) {
          for (const variant of Object.keys(variants as Record<string, unknown>)) {
            voices.push({
              name: `${character}-${variant}`,
              engine: GPTSOVITS_ENGINE,
              lang: languageOf(cloneVoiceLanguage(meta, variant)),
            });
          }
        }
      }
      return voices;
    },
    async speak(text: string, opts: SpeakOptions) {
      const requirement =
        opts.voice === null || opts.voice === DEFAULT_VOICE_KEY
          ? await defaultRequirement(detectTextLang(text))
          : await characterRequirement(opts.voice);
      const speed = wpmToSpeed(opts.rateWpm);
      const result = await synth({
        text,
        refAudioPath: requirement.refAudioPath,
        promptText: requirement.promptText,
        promptLang: requirement.promptLang,
        textLang: detectTextLang(text),
        speedFactor: speed,
      });
      assertAudible(result.samples);
      return { type: "pcm", samples: result.samples, sampleRate: result.sampleRate } as const;
    },
  };
}
