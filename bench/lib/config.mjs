// bench 全局配置：路径、文本集、样本口径常量。
// 文本写死保证跨轮次可复现——改文本即改测量基准，历史 raw-log 与新轮次不可比，需同步报告口径节。
import { homedir } from "node:os";
import path from "node:path";

export const REPO = path.resolve(import.meta.dirname, "..", "..");

/** 产品正式资产位：安装脚本与跑分共用同一目录，模型与二进制不落 repo 内 */
export const CACHE = path.join(homedir(), ".cache", "say");
export const TOOLS = path.join(CACHE, "tools");
export const MODELS = path.join(CACHE, "models");

export const BENCH_DOCS = path.join(REPO, "docs", "research", "bench");
export const SAMPLES = path.join(BENCH_DOCS, "samples");
export const RAW_LOG = path.join(BENCH_DOCS, "raw-log.jsonl");
export const REPORT = path.join(BENCH_DOCS, "report.md");

export const SHERPA_VERSION = "1.13.8";

/** 样本有效性下限：0.5s @22050Hz 16bit 单声道 = 22050 数据字节 */
export const SAMPLE_RATE = 22050;
export const MIN_SAMPLE_DATA_BYTES = 22050;
export const MIN_SAMPLE_DURATION_S = 0.5;

/**
 * 退化音频相对下限：时长 < 同文本 system-say 对照样本的该比例即判退化（非真实语音）。
 * 绝对下限挡不住「长文本却只出零点几秒噪声」的退化形态（单语模型跑外语文本时 exit 0 输出仍可超字节下限），
 * 须以同文本对照锚定；系数须在报告口径节声明。
 */
export const DEGENERATE_RATIO = 0.25;

/** polaris 验收判据（秒） */
export const LIMIT_HOT_S = 3;
export const LIMIT_COLD_S = 10;
/** MARGINAL 上界系数：超标但 ≤1.5× 判 MARGINAL 而非直接 FAIL，该判据须在报告口径节声明 */
export const MARGINAL_FACTOR = 1.5;

/** 每格 run 次数（3 次取中位数） */
export const RUNS = 3;

/**
 * 固定文本集。zh-short 含数字读法（覆盖 sherpa --tts-rule-fsts 路径）；
 * zh-mixed 原样取自蓝图调研设定的真实流量样本（代码术语夹中文），改动会破坏与调研结论的可比性。
 * @type {Record<string, {text: string, lang: "en"|"zh"|"mixed", note: string}>}
 */
export const TEXTS = {
  "en-short": {
    text: "The build finished and all tests passed.",
    lang: "en",
    note: "8 words, daily agent broadcast",
  },
  "en-long": {
    text: "We shipped the new release yesterday after three weeks of focused work, and the feedback from early users has been overwhelmingly positive, especially regarding the improved performance on older hardware, the redesigned onboarding flow, and the fact that the whole migration took less than a single afternoon for most of our teams, which is better than we expected.",
    lang: "en",
    note: "~60 words, long-form broadcast",
  },
  "zh-short": {
    text: "通知：构建完成，用时三分十四秒，请来查收。",
    lang: "zh",
    note: "19 hanzi, covers number-reading rule FSTs",
  },
  "zh-mixed": {
    text: "build 完成了，deploy 到 production 只用了一键",
    lang: "mixed",
    note: "code-switching sample, verbatim from blueprint research",
  },
};

export const TEXT_IDS = Object.keys(TEXTS);
