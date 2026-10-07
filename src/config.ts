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

/** locale 未命中内置预设的语言（zh/en/ja 之外）与配置损坏时的兜底引擎：v1 基线、零资产依赖，保证出声 */
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
 * 内置预设表：voice="default" 关键字按 locale 的零配置落点。
 * 三语默认引擎取 261007 试听裁决（40 组样音矩阵人听定档：zh indextts / en firered /
 * ja gptsovits），取代此前按延迟指标推演的默认引擎结论——延迟达标不等于听感最优。
 * 嗓位：zh/ja 用芙莉莲角色嗓（官方中配/日配参考是各自语种唯一地道音源，中性嗓缺口见
 * gptsovits default-ja）；en 用 firered 内置示例参考（自带女声，其余引擎内置英文参考
 * 多为男声或听感不稳）。要改嗓改 config voice，改引擎改 config engine。
 */
export const BUILTIN_PRESETS: Readonly<Record<string, PresetDefinition>> = {
  en: { voice: "default", engine: "firered" },
  zh: { voice: "frieren-zh", engine: "indextts" },
  ja: { voice: "frieren", engine: "gptsovits" },
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
 * locale 参数在「一切自选」时被消费——voice 是 "default" 关键字或全层缺席，
 * 且 engine 也全层缺席——落按语种的内置预设。任一维度显式在场都不触发，
 * 传与不传无语义差。needsLocale 回传「需要但 locale 未在场」，调用方据此付探测成本。
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

  // 按 locale 落内置预设的触发条件：voice 自选形态（"default" 关键字或全层缺席）
  // 且 engine 也全层缺席——两维同为「一切自选」才是 locale 自动默认的完整语义：
  // 裸调 `say "中文"` 就该落三语默认链。显式指定任一维度即不波及另一维——
  // 显式 -e 引擎时 voice 保持该引擎内置嗓（v1 语义与试听矩阵中性格；强塞角色嗓
  // 给不支持克隆的引擎只会换来无谓回退），显式 -v 音色时引擎自选照旧。
  // 预设的 engine 追加在显式 preset 层之后（locale 落位是最低一档，显式层更具体）。
  const engineLayers: Layer[] = [
    { label: "--engine", value: flags.engine },
    { label: "SAY_ENGINE", value: env.SAY_ENGINE },
    { label: "config engine", value: file.engine },
    presetLayer("engine"),
  ];
  let resolvedVoice = voice;
  const engineSelfSelect = ![flags.engine, env.SAY_ENGINE, file.engine, preset?.engine].some((v) => !isAbsent(v));
  // 两种自选不等价：关键字是明确的「按语言给我嗓」请求——即使引擎已指定也落预设嗓
  // （引擎层显式在场则不波及）；voice 缺席是「一切自选」——只有引擎也缺席才整套落位，
  // 否则缺席保持 null = 所选引擎的内置嗓（v1 语义与试听矩阵中性格）。
  const wantsVoice = voice === DEFAULT_VOICE_KEY;
  const wantsWholePreset = (voice === null || wantsVoice) && engineSelfSelect;
  const wantsLocale = wantsVoice || wantsWholePreset;
  // 门控即解析器：needsLocale 只看解析器是否需要 locale 而未在场，
  // 调用方无须（也不应）自行扫描层源
  const needsLocale = wantsLocale && input.locale === undefined;
  if (wantsLocale) {
    const localeKey = input.locale ?? DEFAULT_LOCALE;
    const localePreset = BUILTIN_PRESETS[localeKey] ?? null;
    if (localePreset === null) {
      // 显式关键字落空要给警告；全缺席本就允许引擎内置嗓，静默继续
      if (wantsVoice) {
        warnings.push(`locale "${localeKey}" 没有内置预设，按引擎默认嗓继续`);
      }
    } else {
      // 关键字与整套自选都换嗓；engine 层只在整套自选时带出
      resolvedVoice = typeof localePreset.voice === "string" ? localePreset.voice : null;
      if (wantsWholePreset) {
        engineLayers.push({ label: `locale ${localeKey}`, value: localePreset.engine });
      }
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

/**
 * SAY_DAEMON 逃生门（票 04 形态共存的环境层开关）：off = 常驻形态整体禁用，
 * 请求直接进 per-call——与 daemon 上线前的行为同形；on/缺席/空串 = daemon-first 缺省。
 * 其它值按 on 处理 + 警告：与环境层坏值降级的既有哲学一致（可用性下限是永远能出声，
 * 一个 typo 不该砍掉热启动收益、更不该瘫痪命令）。[daemon] 配置节与 flag>env>config
 * 三层完整优先级是后续切片（蓝图「SAY_DAEMON 解析先行」口径），此处只钉 env 面。
 */
export function daemonEnabledFromEnv(env: EnvMap): { enabled: boolean; warning: string | null } {
  const raw = env.SAY_DAEMON;
  if (raw === undefined || raw === "" || raw === "on") return { enabled: true, warning: null };
  if (raw === "off") return { enabled: false, warning: null };
  return { enabled: true, warning: `SAY_DAEMON 只能是 "on" 或 "off"，按 on 处理：${JSON.stringify(raw)}` };
}
