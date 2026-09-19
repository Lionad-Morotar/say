import { parse as parseToml } from "smol-toml";
import { messageOf } from "./errors.ts";
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

/**
 * 175 是本机实测的 macOS say 默认语速：同一文本 `say` 与 `say -r 175` 产出时长逐位相同（3.664354s）。
 * 它是 wpm 与引擎倍率之间唯一的换算支点，改了会让 -r 的语义与系统 say 脱钩。
 */
export const DEFAULT_RATE_WPM = 175;

const KNOWN_KEYS = ["engine", "voice", "speed", "fallback"] as const;

export type ConfigFileParse = { ok: true; value: ConfigFile } | { ok: false; error: string };

/**
 * 只做语法层：TOML 解析成功即按已知键摘取原始值，类型校验留给 resolveConfig。
 * 未知键与分节（如后续预设表）静默忽略，向前兼容不靠改代码。
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

/** flag > env > config > 默认。层序是产品口径（手动 -v 被环境变量盖掉属真实困惑场景），不是实现便利 */
export function resolveConfig(input: {
  env: EnvMap;
  file: ConfigFile | null;
  flags: FlagOverrides;
}): ConfigResolution {
  const warnings: string[] = [];
  const { env, flags } = input;
  const file = input.file ?? {};

  const config: ResolvedConfig = {
    engine: pickString(
      [
        { label: "SAY_ENGINE", value: env.SAY_ENGINE },
        { label: "config engine", value: file.engine },
      ],
      DEFAULT_ENGINE,
      warnings,
    ) ?? DEFAULT_ENGINE,
    voice: pickString(
      [
        { label: "-v", value: flags.voice },
        { label: "SAY_VOICE", value: env.SAY_VOICE },
        { label: "config voice", value: file.voice },
      ],
      null,
      warnings,
    ),
    rateWpm: pickRate(
      [
        { label: "-r", value: flags.rateWpm },
        { label: "SAY_SPEED", value: env.SAY_SPEED },
        { label: "config speed", value: file.speed },
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

  return { config, warnings };
}
