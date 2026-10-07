// 简报组装单测：离线纯函数验证矩阵格（三维）、缺采占位、默认链快照与转义；不碰 fs 不打引擎。
import test from "node:test";
import assert from "node:assert/strict";
import { renderBriefingHtml } from "./briefing-html.mjs";

const sample = (voice, file, durationS = 3.21) => ({ voice, file, exists: true, durationS });

const BASE = {
  generatedAt: "2026-10-07T13:00:00+08:00",
  defaultChain: {
    zh: { engine: "gptsovits", voice: "frieren-zh" },
    en: { engine: "sherpa", voice: "af_maple" },
  },
  texts: { zh: "今天天气很好", en: "The weather is fine" },
  engines: [{ name: "gptsovits", hot: "1.6-2.75s PASS", cold: "4.74-5.61s PASS", verdict: "默认引擎" }],
  voices: [{ name: "default", note: "引擎内置中性参考" }],
  rows: [
    {
      engine: "gptsovits",
      cells: {
        zh: [
          sample("default", "audio/gptsovits-zh-default.wav"),
          sample("frieren-zh", "audio/gptsovits-zh-frieren-zh.wav", 4.5),
          { voice: "dva", file: "audio/gptsovits-zh-dva.wav", exists: false },
        ],
        en: [
          { voice: "default", file: "audio/gptsovits-en-default.wav", exists: false },
          { voice: "frieren-en", file: "audio/gptsovits-en-frieren-en.wav", exists: false },
          { voice: "dva", file: "audio/gptsovits-en-dva.wav", exists: false },
        ],
      },
    },
  ],
  knownIssues: ["IndexTTS duration_factor=1.0 输出定长"],
  pendingDecisions: ["ja 是否进语种域"],
};

test("矩阵格：每嗓一行播放器，文件相对路径直出 src，时长随行展示", () => {
  const html = renderBriefingHtml(BASE);
  assert.match(html, /<audio controls preload="none" src="audio\/gptsovits-zh-default\.wav"><\/audio>/);
  assert.match(html, /frieren-zh 4\.50s/);
});

test("全缺格渲染可见占位并点名全部嗓位；部分缺采只补缺采注记不挤掉在盘行", () => {
  const html = renderBriefingHtml(BASE);
  assert.match(html, /缺采<span class="sub">default \/ frieren-en \/ dva<\/span>/);
  assert.match(html, /dva 缺采/);
  assert.match(html, /audio\/gptsovits-zh-frieren-zh\.wav/);
});

test("默认链快照两行都呈现：zh 链与 en 链", () => {
  const html = renderBriefingHtml(BASE);
  assert.match(html, /zh → <code>gptsovits<\/code> \+ <code>frieren-zh<\/code>/);
  assert.match(html, /en → <code>sherpa<\/code> \+ <code>af_maple<\/code>/);
});

test("裁决表、注记与待决清单逐条入文", () => {
  const html = renderBriefingHtml(BASE);
  assert.match(html, /1\.6-2\.75s PASS/);
  assert.match(html, /duration_factor=1\.0 输出定长/);
  assert.match(html, /ja 是否进语种域/);
});

test("用户可见文本经 HTML 转义，注入面在组装层收口", () => {
  const html = renderBriefingHtml({
    ...BASE,
    knownIssues: ['<script>alert("x")</script>'],
  });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("ja 进域：语种集由 texts 键驱动，默认链与矩阵列自动扩第三语种", () => {
  const html = renderBriefingHtml({
    ...BASE,
    defaultChain: { ...BASE.defaultChain, ja: { engine: "gptsovits", voice: "frieren" } },
    texts: { ...BASE.texts, ja: "今日の上海はいい天気です" },
    rows: BASE.rows.map((row) => ({
      ...row,
      cells: { ...row.cells, ja: [{ voice: "frieren", file: "audio/gptsovits-ja-frieren.wav", exists: true }] },
    })),
  });
  assert.match(html, /ja → <code>gptsovits<\/code> \+ <code>frieren<\/code>/);
  assert.match(html, /<th>ja<\/th>/);
  assert.match(html, /audio\/gptsovits-ja-frieren\.wav/);
  assert.match(html, /3 语种/);
});
