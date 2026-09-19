import { describe, expect, it } from "vitest";
import {
  CHUNK_BUDGET,
  CHUNK_THRESHOLD,
  FIRST_CHUNK_BUDGET,
  approxTokens,
  chunkText,
  normalizeText,
  splitSentences,
} from "../src/normalize.ts";

/** 造一句约 tokens 个近似 token 的英文：三字符词加一个空格正好四字符，与「非 CJK 四字符一 token」的口径对齐 */
function sentence(words: number, end = "."): string {
  return `${Array.from({ length: words }, (_, i) => `w${i}`.padEnd(3, "x")).join(" ")}${end}`;
}

function paragraph(sentences: number, words: number): string {
  return Array.from({ length: sentences }, () => sentence(words)).join(" ");
}

/** 分块必须无损：把所有块拼回去、抹掉空白后要与规范化原文逐字相同 */
function letters(text: string): string {
  return text.replace(/\s+/g, "");
}

describe("approxTokens：kokoro 分词量的近似口径", () => {
  it("空串是零 token", () => {
    expect(approxTokens("")).toBe(0);
  });

  it("CJK 一字一 token：汉字、假名同权", () => {
    expect(approxTokens("哇")).toBe(1);
    expect(approxTokens("你好世界")).toBe(4);
    expect(approxTokens("こんにちは")).toBe(5);
  });

  it("非 CJK 四字符一 token，不足四字进一", () => {
    expect(approxTokens("abcd")).toBe(1);
    expect(approxTokens("abcde")).toBe(2);
    expect(approxTokens("abcdefgh")).toBe(2);
  });

  it("中英混排两段分别计价", () => {
    expect(approxTokens("你好abcd")).toBe(3);
  });

  it("空白不计价：换行与缩进不该把一段短文推过分块阈值", () => {
    expect(approxTokens("  a b  ")).toBe(1);
    expect(approxTokens("\n\n\t")).toBe(0);
  });
});

describe("normalizeText：送进引擎前的文本整理", () => {
  it("折叠连续空格与制表符，首尾空白去掉", () => {
    expect(normalizeText("  a \t   b  ")).toBe("a b");
  });

  it("换行保留：它是句边界，抹平会让多行文件黏成一句", () => {
    expect(normalizeText("a\nb")).toBe("a\nb");
    expect(normalizeText("\n\n hi \n")).toBe("hi");
  });

  it("已经规范的文本原样返回，多次调用幂等", () => {
    const once = normalizeText("hello world");
    expect(once).toBe("hello world");
    expect(normalizeText(once)).toBe(once);
  });

  it("空串与纯空白都归零", () => {
    expect(normalizeText("")).toBe("");
    expect(normalizeText("   \n\t ")).toBe("");
  });
});

describe("splitSentences：句边界识别", () => {
  it("英文句末标点切开，标点留在前一句", () => {
    expect(splitSentences("One. Two!")).toEqual(["One.", "Two!"]);
  });

  it("中文句末标点同样切开", () => {
    expect(splitSentences("你好。世界！")).toEqual(["你好。", "世界！"]);
  });

  it("连续标点算同一个句尾，不会被切成空句", () => {
    expect(splitSentences("What?! Really.")).toEqual(["What?!", "Really."]);
    expect(splitSentences("等一下……")).toEqual(["等一下……"]);
  });

  it("小数点不当句尾：3.14 被切开就会念成「三」和「十四」", () => {
    expect(splitSentences("Pi is 3.14 and so on.")).toEqual(["Pi is 3.14 and so on."]);
  });

  it("换行是句边界", () => {
    expect(splitSentences("first\nsecond")).toEqual(["first", "second"]);
  });

  it("分号也是句边界", () => {
    expect(splitSentences("a; b")).toEqual(["a;", "b"]);
  });

  it("末尾没有标点的残句保留", () => {
    expect(splitSentences("Done. trailing")).toEqual(["Done.", "trailing"]);
  });

  it("空串与纯空白不产生句子", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("  \n ")).toEqual([]);
  });
});

describe("chunkText：分块阈值与预算", () => {
  it("空文本不产生块", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n ")).toEqual([]);
  });

  it("超短句直通：不查句边界也不分块，行为与长文本同一入口", () => {
    expect(chunkText("哇")).toEqual(["哇"]);
    expect(chunkText("hello")).toEqual(["hello"]);
  });

  it("阈值内整段一块，哪怕一个标点都没有", () => {
    const short = sentence(400);
    expect(approxTokens(short)).toBeLessThanOrEqual(CHUNK_THRESHOLD);
    expect(chunkText(short)).toEqual([normalizeText(short)]);
  });

  it("超过阈值按句边界分块", () => {
    const chunks = chunkText(paragraph(40, 20));
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("首块预算小、后续块预算大：首次出声延迟与播放开销摊薄是一对矛盾", () => {
    expect(FIRST_CHUNK_BUDGET).toBeLessThan(CHUNK_BUDGET);
    const chunks = chunkText(paragraph(40, 20));
    expect(approxTokens(chunks[0]!)).toBeLessThanOrEqual(FIRST_CHUNK_BUDGET);
    for (const chunk of chunks.slice(1)) {
      expect(approxTokens(chunk)).toBeLessThanOrEqual(CHUNK_BUDGET);
    }
  });

  it("预算逐块放大到上限：第二块直接跳到上限，播完首块时它还远没合成完", () => {
    const budgets = chunkText(paragraph(60, 20)).map(approxTokens);
    expect(budgets.length).toBeGreaterThan(3);
    expect(budgets[1]!).toBeGreaterThan(budgets[0]!);
    expect(budgets[2]!).toBeGreaterThan(budgets[1]!);
    for (const budget of budgets) expect(budget).toBeLessThanOrEqual(CHUNK_BUDGET);
  });

  it("分块无损：拼回去抹掉空白与规范化原文逐字相同", () => {
    const text = paragraph(40, 20);
    expect(letters(chunkText(text).join(""))).toBe(letters(normalizeText(text)));
  });

  it("整段没有一个句边界时按字符硬切，不会因为切不开而放弃分块", () => {
    const blob = sentence(1200);
    expect(splitSentences(blob)).toHaveLength(1);
    const chunks = chunkText(blob);
    expect(chunks.length).toBeGreaterThan(1);
    expect(approxTokens(chunks[0]!)).toBeLessThanOrEqual(FIRST_CHUNK_BUDGET);
    expect(letters(chunks.join(""))).toBe(letters(normalizeText(blob)));
  });

  it("多行文件按行再按句分块，行内容不会跨块黏连", () => {
    const text = Array.from({ length: 30 }, () => sentence(20)).join("\n");
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(letters(chunks.join(""))).toBe(letters(normalizeText(text)));
  });

  it("每块都非空：空块交给引擎只会换来一次报错或一段静音", () => {
    for (const chunk of chunkText(paragraph(40, 20))) {
      expect(chunk.trim().length).toBeGreaterThan(0);
    }
  });
});
