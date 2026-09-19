/**
 * 文本规范化与分块。
 *
 * 分块存在的理由是两件事：一次合成的文本越长，首次出声越晚；播放每一块都要付一次
 * afplay 启动开销（实测约 1.0s），块切得越碎，这段静音越多。两个方向相反，
 * 所以预算不是常数——首块取小换首次出声，后续块取大摊薄播放开销。
 */

/**
 * 近似 token 阈值。低于它整段一次交给引擎：分块本身会在边界处引入停顿，
 * 短文本付这个代价换不到任何延迟收益。
 */
export const CHUNK_THRESHOLD = 400;

/**
 * 首块预算。实测 30 近似 token 约 15 个英文词、4.7s 音频，合成 1.86s 叠加模型载入 0.69s，
 * 再加 afplay 约 1.0s 的启动开销，首次出声约 3.5s。
 * 再往下压意义不大：一个英文句本身就是 19 近似 token 量级，更小的预算只会把首句硬切成半句。
 */
export const FIRST_CHUNK_BUDGET = 30;

/** 后续块的预算上限。160 近似 token 约 38s 音频，afplay 那 1.0s 固定开销占比可忽略 */
export const CHUNK_BUDGET = 160;

/**
 * 预算逐块放大的倍率。流水线不断流的条件是「合成下一块的耗时 ≤ 播放本块的耗时」，
 * 即 RTF × 下一块时长 ≤ 本块时长 + afplay 启动开销；实测 RTF 0.37-0.54，
 * 取 2.5 是该不等式在 RTF 0.4 下的上界。首块很小，若第二块直接跳到上限，
 * 播完首块时第二块还远没合成完，中间会出现数秒可闻的空白。
 */
const BUDGET_GROWTH = 2.5;

/**
 * CJK 计价为一字一 token：汉字（含扩展 A 与兼容表意）、假名、谚文、半角片假名。
 * 拉丁语系按四字符一 token，与 kokoro 分词器的实测量级一致。
 * 这是近似值，目的是给分块一个稳定的量纲，不追求与真实分词逐 token 相等。
 */
const CJK = /[\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff66-\uff9f]/u;
const SPACE = /\s/;
const DIGIT = /\d/;

const CJK_WEIGHT = 1;
const OTHER_WEIGHT = 1 / 4;

function charWeight(ch: string): number {
  if (SPACE.test(ch)) return 0;
  return CJK.test(ch) ? CJK_WEIGHT : OTHER_WEIGHT;
}

/** 近似 token 数。权重累加后统一进一，因此分段求和会略高于整段，分块只会偏保守 */
export function approxTokens(text: string): number {
  let weight = 0;
  for (const ch of text) weight += charWeight(ch);
  return Math.ceil(weight);
}

/**
 * 折叠横向空白、去首尾空白，但保留换行。
 * 换行是多行文件的句边界，抹平会让本不相干的两行黏成一句。
 */
export function normalizeText(text: string): string {
  return text.replace(/[ \t\r\f\v]+/g, " ").trim();
}

/**
 * 句尾标点。省略号与缩写点不在列内：前者本身不构成边界，
 * 后者要靠词典才判得准，宁可少切一块也不要念错一个词。
 */
const TERMINATORS = new Set([".", "!", "?", ";", "。", "！", "？", "；", "\n"]);

/** 小数点不是句尾：3.14 被切开就会念成「三」和「十四」，比多一个长块严重得多 */
function isDecimalPoint(text: string, index: number): boolean {
  if (text[index] !== ".") return false;
  return DIGIT.test(text[index - 1] ?? "") && DIGIT.test(text[index + 1] ?? "");
}

function pushSentence(sentences: string[], piece: string): void {
  const trimmed = piece.trim();
  if (trimmed.length > 0) sentences.push(trimmed);
}

/** 按句边界切分，标点留在前一句。空白片段丢弃，连续标点算同一个句尾 */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (!TERMINATORS.has(text[index]!) || isDecimalPoint(text, index)) continue;
    while (index + 1 < text.length && TERMINATORS.has(text[index + 1]!)) index++;
    pushSentence(sentences, text.slice(start, index + 1));
    start = index + 1;
  }
  pushSentence(sentences, text.slice(start));
  return sentences;
}

/**
 * 单句就超预算时按字符硬切。首块沿用当前（可能很小的）预算保住首次出声延迟，
 * 其余块用大预算摊薄播放开销。切点不落在词边界上，但一个没有标点的千字长句
 * 本就无从判断语义边界，切开的代价远小于整段一次性合成的等待。
 */
function hardSplit(sentence: string, firstBudget: number, restBudget: number): string[] {
  const pieces: string[] = [];
  let start = 0;
  let budget = firstBudget;
  while (start < sentence.length) {
    let end = start;
    let weight = 0;
    while (end < sentence.length) {
      const next = weight + charWeight(sentence[end]!);
      // end > start 保证每轮至少吃进一个字符：单字符就超预算时也要前进，否则死循环
      if (end > start && Math.ceil(next) > budget) break;
      weight = next;
      end++;
    }
    pieces.push(sentence.slice(start, end));
    start = end;
    budget = restBudget;
  }
  return pieces;
}

/**
 * 把正文切成交付块。返回空数组表示没有可说的内容；
 * 返回单元素表示整段直通，超短句与阈值内的长句都走这条路，调用方不需要区分。
 */
export function chunkText(text: string): string[] {
  const normalized = normalizeText(text);
  if (normalized.length === 0) return [];
  if (approxTokens(normalized) <= CHUNK_THRESHOLD) return [normalized];

  const chunks: string[] = [];
  let budget = FIRST_CHUNK_BUDGET;
  let current = "";
  let currentTokens = 0;

  const grow = (): void => {
    budget = Math.min(CHUNK_BUDGET, Math.ceil(budget * BUDGET_GROWTH));
  };

  const flush = (): void => {
    if (current.trim().length === 0) return;
    chunks.push(current.trim());
    current = "";
    currentTokens = 0;
    // 每交付一块就把下一块的预算放大一档，逐步逼近上限：
    // 一步跳到上限会在起步阶段留出可闻空白，恒定小预算又会让 afplay 的固定开销占比过高
    grow();
  };

  for (const sentence of splitSentences(normalized)) {
    const tokens = approxTokens(sentence);
    if (tokens > budget) {
      // 先记下当前预算再 flush：flush 会放大预算，而硬切的首段要沿用放大前的那一档
      const limit = budget;
      flush();
      chunks.push(...hardSplit(sentence, limit, CHUNK_BUDGET));
      budget = CHUNK_BUDGET;
      continue;
    }
    if (currentTokens + tokens > budget) flush();
    current = current.length === 0 ? sentence : `${current} ${sentence}`;
    currentTokens += tokens;
  }
  flush();
  return chunks;
}
