import { parse as parseToml } from "smol-toml";
import { messageOf } from "./errors.ts";
import type { LocaleLang } from "./locale.ts";
import type {
  ConfigFile,
  ConfigResolution,
  EnvMap,
  FallbackPolicy,
  FlagOverrides,
  ResolvedConfig,
} from "./types.ts";

/** 默认引擎必须指向已登记的引擎，否则零配置调用会直接失败而不是出声 */
export const DEFAULT_ENGINE = "sherpa";
export const DEFAULT_FALLBACK: FallbackPolicy = "system";

/** locale 探测的缺省落点（map 裁决「缺省 en」） */
export const DEFAULT_LOCALE: LocaleLang = "en";

/**
 * v2 一期 voice 关键字：按 locale 落 en/zh 内置预设。
 * frieren/dva 不在此层处理——它们是角色嗓，由引擎的 ownsVoice 认领，config 只透传名字。
 */
export const DEFAULT_VOICE_KEY = "default";

/**
 * 175 是本机实测的 macOS say 默认语速：同一文本 `say` 与 `say -r 175` 产出时长逐位相同（3.664354s）。
 * 它是 wpm 与引擎倍率之间唯一的换算支点，改了会让 -r 的语义与系统 say 脱钩。
 */
export const DEFAULT_RATE_WPM = 175;

const KNOWN_KEYS = ["engine", "voice", "speed", "fallback", "preset", "presets"] as const;

/**
 * 内置通用嗓预设：验收第三条（en/zh 各 ≥1）的零配置落点。
 * zh 择优 matcha（zh_baker）：本机实测短句热态 0.41s，是全部通道里最快的中文嗓
 * （kokoro zh 热 2.57s 且官方自评中文 D 级）；en 走 kokoro 默认嗓（en A 级口碑，1.59s）。
 * matcha 单女声且数据集非商用，个人使用注记见蓝图。
 */
export const BUILTIN_PRESETS: Readonly<Record<string, PresetDefinition>> = {
  en: { voice: "af_maple", engine: "sherpa" },
  zh: { voice: "zh_baker", engine: "sherpa" },
};

export type ConfigFileParse = { ok: true; value: ConfigFile } | { ok: false; error: string };

/**
 * 只做语法层：TOML 解析成功即按已知键摘取原始值，类型校验留给 resolveConfig。
 * 未知键与分节静默忽略，向前兼容不靠改代码。
 */
export function parseConfigFile(text: string): ConfigFileParse {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "配置文件顶层不是一个表" };
  }
  const table = raw as Record<string, unknown>;
  const value: ConfigFile = {};
  for (const key of KNOWN_KEYS) {
    if (table[key] !== undefined) value[key] = table[key];
  }
  return { ok: true, value };
}

/** 预设条目：音色×语速×引擎组合，speed 与 -r 同单位（wpm）。字段值原样保留，类型宽容归 pick 层 */
export interface PresetDefinition {
  voice?: unknown;
  speed?: unknown;
  engine?: unknown;
}

type PresetTable = Readonly<Record<string, PresetDefinition>>;

/** config presets 表与内置表合并，坏条目降级并警告，不拖垮其余预设 */
function mergePresetTables(raw: unknown, warnings: string[]): PresetTable {
  const merged: Record<string, PresetDefinition> = { ...BUILTIN_PRESETS };
  if (isAbsent(raw)) return merged;
  // 数组 typeof 也是 "object"：不拦住会把条目按索引并成名为 "0" 的幻影预设
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push(`config presets 期望分节表，已忽略：${JSON.stringify(raw)}`);
    return merged;
  }
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      warnings.push(`config presets.${name} 期望表，已忽略：${JSON.stringify(entry)}`);
      continue;
    }
    merged[name] = entry as PresetDefinition;
  }
  return merged;
}

interface Layer {
  label: string;
  value: unknown;
}

/** 空串与 null/undefined 同义：shell 里 `export SAY_VOICE=` 是取消覆盖，不是把音色设成空名 */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/**
 * 环境层（config 文件与 env）坏值一律降级 + 警告，不硬失败。
 * say 的可用性下限是「永远能出声」，一个配置 typo 不该让整个命令瘫痪；
 * 与之对照，命令行 flag 的坏值在 cli 层就判用法错误——那是本次调用的显式意图，应当吵闹地失败。
 */
function pickString(layers: readonly Layer[], fallback: string | null, warnings: string[]): string | null {
  for (const layer of layers) {
    if (isAbsent(layer.value)) continue;
    if (typeof layer.value === "string") return layer.value;
    warnings.push(`${layer.label} 期望字符串，已忽略：${JSON.stringify(layer.value)}`);
  }
  return fallback;
}

function pickRate(layers: readonly Layer[], warnings: string[]): number {
  for (const layer of layers) {
    if (isAbsent(layer.value)) continue;
    const value = typeof layer.value === "number" ? layer.value : Number(layer.value);
    if (Number.isFinite(value) && value > 0) return value;
    warnings.push(`${layer.label} 不是正数 wpm，已忽略：${String(layer.value)}`);
  }
  return DEFAULT_RATE_WPM;
}

function pickFallback(layers: readonly Layer[], warnings: string[]): FallbackPolicy {
  for (const layer of layers) {
    if (isAbsent(layer.value)) continue;
    if (layer.value === "system" || layer.value === "off") return layer.value;
    warnings.push(`${layer.label} 只能是 "system" 或 "off"，已忽略：${String(layer.value)}`);
  }
  return DEFAULT_FALLBACK;
}

/**
 * 预设选择与预设值的层序各自独立：
 * 选哪条预设按 flag > env > config；预设里的 voice/speed/engine 是最低一档显式层，
 * 手动指定的维度永远胜过预设值——预设是「一套默认组合」，不是更高优先级的覆盖。
 *
 * locale 参数只在 voice="default" 关键字生效时被消费（选 en/zh 内置预设），
 * 非关键字路径下传与不传无语义差，调用方可据此省掉 locale 探测的子进程成本。
 */
export function resolveConfig(input: {
  env: EnvMap;
  file: ConfigFile | null;
  flags: FlagOverrides;
  locale?: LocaleLang;
}): ConfigResolution {
  const warnings: string[] = [];
  const { env, flags } = input;
  const file = input.file ?? {};

  const presets = mergePresetTables(file.presets, warnings);
  const presetName = pickString(
    [
      { label: "--preset", value: flags.preset },
      { label: "SAY_PRESET", value: env.SAY_PRESET },
      { label: "config preset", value: file.preset },
    ],
    null,
    warnings,
  );
  let preset: PresetDefinition | null = null;
  if (presetName !== null) {
    preset = presets[presetName] ?? null;
    if (preset === null) {
      warnings.push(`未登记的预设 "${presetName}"（可用：${Object.keys(presets).join(", ")}），已忽略`);
    }
  }
  const presetLayer = (field: keyof PresetDefinition): Layer => ({
    label: `preset ${presetName ?? ""}`.trim(),
    value: preset?.[field],
  });

  const voice = pickString(
    [
      { label: "-v", value: flags.voice },
      { label: "SAY_VOICE", value: env.SAY_VOICE },
      { label: "config voice", value: file.voice },
      presetLayer("voice"),
    ],
    null,
    warnings,
  );

  // voice="default" 关键字按 locale 落内置预设：voice 直接换成预设值，
  // 预设的 engine 追加在显式 preset 层之后（locale 默认预设是最低一档，显式 preset 更具体）。
  // 胜出层是 "default" 才解析——其他层给的普通音色名不被关键字波及。
  const engineLayers: Layer[] = [
    { label: "--engine", value: flags.engine },
    { label: "SAY_ENGINE", value: env.SAY_ENGINE },
    { label: "config engine", value: file.engine },
    presetLayer("engine"),
  ];
  let resolvedVoice = voice;
  // 门控即解析器：needsLocale 只看胜出层是否命中关键字，调用方无须（也不应）自行扫描层源
  const needsLocale = voice === DEFAULT_VOICE_KEY && input.locale === undefined;
  if (voice === DEFAULT_VOICE_KEY) {
    const localeKey = input.locale ?? DEFAULT_LOCALE;
    const localePreset = BUILTIN_PRESETS[localeKey] ?? null;
    if (localePreset === null) {
      warnings.push(`locale "${localeKey}" 没有内置预设，按引擎默认嗓继续`);
    } else {
      resolvedVoice = typeof localePreset.voice === "string" ? localePreset.voice : null;
      engineLayers.push({ label: `locale ${localeKey}`, value: localePreset.engine });
    }
  }

  const config: ResolvedConfig = {
    engine: pickString(engineLayers, DEFAULT_ENGINE, warnings) ?? DEFAULT_ENGINE,
    voice: resolvedVoice,
    rateWpm: pickRate(
      [
        { label: "-r", value: flags.rateWpm },
        { label: "SAY_SPEED", value: env.SAY_SPEED },
        { label: "config speed", value: file.speed },
        presetLayer("speed"),
      ],
      warnings,
    ),
    fallback: pickFallback(
      [
        { label: "SAY_FALLBACK", value: env.SAY_FALLBACK },
        { label: "config fallback", value: file.fallback },
      ],
      warnings,
    ),
    debug: env.SAY_DEBUG === "1",
  };

  return { config, warnings, needsLocale };
}
