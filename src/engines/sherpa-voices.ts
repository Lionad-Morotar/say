/**
 * sherpa 静态音色登记面。
 *
 * kokoro 的 voices.bin 只存风格嵌入向量、不带名字，模型目录里也没有任何名字清单，
 * 因此「按目录扫描得到音色名」在说话人粒度上物理不可行——名字只能内嵌。
 * 内嵌表的风险是资产换版后 sid 错配，届时会读出另一个嗓子而非报错，
 * 所以适配器在运行期用绑定的 numSpeakers 交叉校验本表长度，错配即失败并触发回退。
 */

export const KOKORO_VOICE_COUNT = 103;

/** 下标即 sid。来源是上游发布的 sid → name 对照，经条目数、连续性、前缀计数与前缀区间四重核对 */
export const KOKORO_VOICES: readonly string[] = [
  // af 美式女声：sid 0 - 1
  "af_maple", "af_sol",
  // bf 英式女声：sid 2 - 2
  "bf_vale",
  // zf 中文女声：sid 3 - 57
  "zf_001", "zf_002", "zf_003", "zf_004", "zf_005", "zf_006",
  "zf_007", "zf_008", "zf_017", "zf_018", "zf_019", "zf_021",
  "zf_022", "zf_023", "zf_024", "zf_026", "zf_027", "zf_028",
  "zf_032", "zf_036", "zf_038", "zf_039", "zf_040", "zf_042",
  "zf_043", "zf_044", "zf_046", "zf_047", "zf_048", "zf_049",
  "zf_051", "zf_059", "zf_060", "zf_067", "zf_070", "zf_071",
  "zf_072", "zf_073", "zf_074", "zf_075", "zf_076", "zf_077",
  "zf_078", "zf_079", "zf_083", "zf_084", "zf_085", "zf_086",
  "zf_087", "zf_088", "zf_090", "zf_092", "zf_093", "zf_094",
  "zf_099",
  // zm 中文男声：sid 58 - 102
  "zm_009", "zm_010", "zm_011", "zm_012", "zm_013", "zm_014",
  "zm_015", "zm_016", "zm_020", "zm_025", "zm_029", "zm_030",
  "zm_031", "zm_033", "zm_034", "zm_035", "zm_037", "zm_041",
  "zm_045", "zm_050", "zm_052", "zm_053", "zm_054", "zm_055",
  "zm_056", "zm_057", "zm_058", "zm_061", "zm_062", "zm_063",
  "zm_064", "zm_065", "zm_066", "zm_068", "zm_069", "zm_080",
  "zm_081", "zm_082", "zm_089", "zm_091", "zm_095", "zm_096",
  "zm_097", "zm_098", "zm_100",
];

/** matcha 只有一个嗓子，别名让 `-v baker` 与 `-v zh_baker` 同义 */
export const MATCHA_VOICES: readonly { name: string; sid: number }[] = [
  { name: "zh_baker", sid: 0 },
  { name: "baker", sid: 0 },
];

const KOKORO_SIDS: ReadonlyMap<string, number> = new Map(KOKORO_VOICES.map((name, sid) => [name, sid]));

const MATCHA_SIDS: ReadonlyMap<string, number> = new Map(MATCHA_VOICES.map((voice) => [voice.name, voice.sid]));

/** 前缀即语言身份：af/bf 是英语母语嗓，zf/zm 是中文母语嗓，两者都能读另一种语言的文本 */
function kokoroLangOf(name: string): "en" | "zh" {
  return name.startsWith("zf") || name.startsWith("zm") ? "zh" : "en";
}

export const SHERPA_VOICE_LANGS: ReadonlyMap<string, "en" | "zh"> = new Map<string, "en" | "zh">([
  ...KOKORO_VOICES.map((name) => [name, kokoroLangOf(name)] as const),
  ...MATCHA_VOICES.map((voice) => [voice.name, "zh"] as const),
]);

export function kokoroSidOf(name: string): number | null {
  return KOKORO_SIDS.get(name) ?? null;
}

export function matchaSidOf(name: string): number | null {
  return MATCHA_SIDS.get(name) ?? null;
}

export function sherpaVoiceLang(name: string): "en" | "zh" | null {
  return SHERPA_VOICE_LANGS.get(name) ?? null;
}

export function isSherpaVoice(name: string): boolean {
  return SHERPA_VOICE_LANGS.has(name);
}
