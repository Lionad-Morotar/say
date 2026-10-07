// 默认裁决试听简报生成器（engine-v2 S8）：采样音 → 组装 HTML → 落盘。
// 样音逐格 spawn 本仓 CLI 真实合成（引擎安装是前置，`say engine ls` 可查）；
// stderr 带 fallback 前缀 = 该格不是目标引擎出的声，按缺采处置而非留污染证据。
// 幂等：在盘且非空的 wav 跳过重采，改判默认预设后重跑本脚本只补缺并重写 HTML。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderBriefingHtml } from "./lib/briefing-html.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SLUG = "slice-s8-locale-brief";
const OUT_DIR = join(REPO_ROOT, "docs/reports/261007");
const AUDIO_DIR = join(OUT_DIR, `${SLUG}-audio`);
const HTML_PATH = join(OUT_DIR, `${SLUG}-briefing.html`);
/** 回退原因行的固定前缀（src/fallback.ts 真源），脚本据此判「这次不是目标引擎出的声」 */
const FALLBACK_PREFIX = "fallback: ";

const TEXTS = {
  zh: "今天上海天气很好，微风拂面，适合出门散步。",
  en: "The weather in Shanghai is lovely today, and a gentle breeze is blowing.",
  ja: "今日の上海はいい天気で、そよ風が吹いています。",
};

/** 矩阵：引擎 × 语种 × 嗓。frieren 跨语行取语言变体（主参考是日配），dva/lucy 以 en 主参考跨语读中文 */
const ENGINES = ["gptsovits", "voxcpm", "indextts", "firered"];
/** ja 行嗓位：default（gptsovits 走 default-zh 参考降级，其余引擎内置说话人）+ frieren 日配主参考；
 * 角色跨语（dva/lucy 读日文）不进本矩阵——三引擎对 ja 条件化质量未经裁决面背书，先保 ja×2 核心格 */
const VOICES = {
  zh: ["default", "frieren-zh", "dva", "lucy"],
  en: ["default", "frieren-en", "dva", "lucy"],
  ja: ["default", "frieren"],
};

/** 蓝图票 07 Resolution 裁决表摘要（评测报告见 docs/research/261006-*.md） */
const ENGINE_VERDICTS = {
  gptsovits: { hot: "1.60-2.75s PASS（CPU）", cold: "4.74-5.61s PASS", verdict: "默认引擎：唯一中英热延迟双 PASS + 角色资产零改造映射" },
  voxcpm: { hot: "3.49s MARGINAL（整句）/ 首包 0.21-0.54s（流式）", cold: "3.3-3.6s PASS", verdict: "质量上限选项：流式形态接线，整句热延迟不过线不作默认" },
  indextts: { hot: "3.9-5.7s FAIL", cold: "9.17s 达标", verdict: "可切换：duration_factor 节奏控制最强，许可商用线中英不一" },
  firered: { hot: "4.45-5.50s FAIL", cold: "10.0s 压线", verdict: "可切换：Instruct 控制面（语速/pitch/volume）能力强但一期未接线（票 08 backlog），资产最重（lab 实测 39G）" },
};

const VOICE_NOTES = [
  { name: "default", note: "引擎内置参考、性别不一（261007 试听坐实）：gptsovits/indextts 官方示例参考为男声；firered 自带示例参考为女声；voxcpm 走文本指令嗓（voice creation，性别随指令）。要女声中性嗓勿用 default 格" },
  { name: "frieren-zh / frieren-en / frieren(ja)", note: "芙莉莲官方中配（李蝉妃）/英配（Mallory Roddak）/日配主参考（種﨑敦美，ja 行裸名 frieren 即落它），零样本克隆。zh 参考 261007 修复：原 20.8s 窗混入村长（男声）台词致克隆出男声，现取 3.24s 芙莉莲独句；en 窗 0-8.4s 前三句（原 14s 致 voxcpm 塌男声）" },
  { name: "dva", note: "D.Va 官方英配（Charlet Chung）素材；zh 行是 en 参考跨语读中文，可听各引擎跨语能力" },
  { name: "lucy", note: "露西 官方英配（Emi Lo，赛博浪客 S1E2）素材，demucs 分离 v1 资产；zh 行同为跨语读法。干净音源补采另行推进" },
];

const KNOWN_ISSUES = [
  "IndexTTS duration_factor=1.0 时输出定长（zh/en 异文本同为 4.748s）：听感若见「不同句子同长」即此现象，-r 语速参数走倍率映射可解",
  "ja 语种域 261007 进域：假名文本走 ja 条件化（四引擎官方面全支持——GPT-SoVITS ja 码、IndexTTS LANGUAGES、FireRed Japanese tag、VoxCPM2 30 语）；已知边界为纯汉字无假名日文句不可分按 zh 走",
  "gptsovits 的 ja default 格是 default-zh 参考降级（无日音中性资产），音色带中文腔、发音按 ja 条件化；地道日音听 frieren 格。参考长音频（>10s 实测）会致 voxcpm 零样本失稳（塌男声/无浊音），角色资产已窗规整至 3-10s",
  "样音为单次合成实例，延迟数字以裁决表实测为准（样音采集走 -o 落盘路径，不含播放流水）",
];

const PENDING_DECISIONS = [
  "默认嗓改判：试听后把 config voice 改成任意嗓位（见改判指引），或维持 frieren-zh",
  "ja 进域后的质量背书：本批 ja×8 格样音为四引擎 ja 条件化首采，听感若不过关再裁决 ja 默认链与逐引擎优化面",
];

/** 标准 PCM wav 头解析出秒长：byteRate 与 data 块大小都在头部固定偏移，样音量级整读无压力 */
export function wavDurationS(file) {
  try {
    const buf = readFileSync(file);
    if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") return null;
    const byteRate = buf.readUInt32LE(28);
    let offset = 12;
    while (offset + 8 <= buf.length) {
      const id = buf.toString("ascii", offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      if (id === "data") return byteRate > 0 ? (size / byteRate) : null;
      offset += 8 + size + (size % 2);
    }
    return null;
  } catch {
    return null;
  }
}

/** 引擎安装面预检：非 ready 的引擎整行跳采，矩阵标缺采并注记原因（比逐格失败快四倍） */
function readyEngines() {
  const outcome = spawnSync(process.execPath, ["scripts/install-engine.mjs", "status", "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (outcome.status !== 0) return { ready: ENGINES, note: "status 查询失败，按全引擎尝试" };
  try {
    const parsed = JSON.parse(outcome.stdout);
    // status --json 是 {labRoot, engines[]} 包装，引擎条目在 engines 字段
    const entries = Array.isArray(parsed) ? parsed : (parsed.engines ?? []);
    const ready = new Set(entries.filter((entry) => entry.status === "ready").map((entry) => entry.engine));
    const skipped = ENGINES.filter((engine) => !ready.has(engine));
    return { ready: ENGINES.filter((engine) => ready.has(engine)), note: skipped.length > 0 ? `未就绪跳采：${skipped.join(", ")}` : "" };
  } catch {
    return { ready: ENGINES, note: "status 输出不可解析，按全引擎尝试" };
  }
}

/** 采一格：exit 0 + 无 fallback 前缀 + 产物非零字节才认在盘，否则清残留按缺采记 */
function captureSample(engine, lang, voice) {
  const file = join(AUDIO_DIR, `${engine}-${lang}-${voice}.wav`);
  const relFile = relative(OUT_DIR, file);
  if (existsSync(file) && statSync(file).size > 0) {
    return { engine, lang, voice, file: relFile, exists: true, durationS: wavDurationS(file) };
  }
  // "default" 是 config 层关键字（-v default 会被解析成 locale 预设的具体嗓名），
  // 中性格要的是引擎默认嗓语义 = voice 缺省不传，让 config.voice 落 null 走引擎内置参考
  const voiceArgs = voice === "default" ? [] : ["--voice", voice];
  const outcome = spawnSync(process.execPath, [join(REPO_ROOT, "bin/say"), TEXTS[lang], "--engine", engine, ...voiceArgs, "--output-file", file], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const fellBack = (outcome.stderr ?? "").includes(FALLBACK_PREFIX);
  if (outcome.status !== 0 || fellBack || !existsSync(file) || statSync(file).size === 0) {
    if (existsSync(file)) rmSync(file);
    const reason = fellBack ? "引擎回退" : outcome.status !== 0 ? `exit ${outcome.status}` : "产物空";
    process.stderr.write(`[gen-briefing] ${engine}/${lang}/${voice} 缺采（${reason}）\n`);
    return { engine, lang, voice, file: relFile, exists: false };
  }
  return { engine, lang, voice, file: relFile, exists: true, durationS: wavDurationS(file) };
}

export function main() {
  mkdirSync(AUDIO_DIR, { recursive: true });
  const { ready, note } = readyEngines();
  if (note) process.stderr.write(`[gen-briefing] ${note}\n`);

  const rows = [];
  for (const engine of ENGINES) {
    const cells = {};
    for (const lang of Object.keys(VOICES)) {
      // 每格 = 该语种全部嗓位逐个采（角色是矩阵第三维）；引擎未就绪整格缺采
      cells[lang] = ready.includes(engine)
        ? VOICES[lang].map((voice) => captureSample(engine, lang, voice))
        : VOICES[lang].map((voice) => ({ voice, file: `${engine}-${lang}-${voice}.wav`, exists: false }));
    }
    rows.push({ engine, cells });
  }

  const html = renderBriefingHtml({
    generatedAt: new Date().toISOString(),
    defaultChain: {
      zh: { engine: "gptsovits", voice: "frieren-zh" },
      en: { engine: "sherpa", voice: "af_maple" },
      ja: { engine: "gptsovits", voice: "frieren" },
    },
    texts: TEXTS,
    engines: ENGINES.map((name) => ({ name, ...ENGINE_VERDICTS[name] })),
    rows,
    voices: VOICE_NOTES,
    knownIssues: KNOWN_ISSUES,
    pendingDecisions: PENDING_DECISIONS,
  });
  writeFileSync(HTML_PATH, html);
  const cells = rows.flatMap((row) => Object.values(row.cells).flat());
  const total = cells.filter((sample) => sample.exists).length;
  process.stdout.write(`[gen-briefing] ${total}/${cells.length} 格在盘，简报：${HTML_PATH}\n`);
}

// import 消费（单测）不触发采集，直跑才进入主流程
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
