// 默认裁决试听简报的 HTML 组装（engine-v2 S8）：纯函数、不打网络不碰 fs，
// 样音采集（gen-briefing.mjs spawn CLI）与页面呈现解耦，改判默认预设后重跑采集即可再生成。
// 数据契约见 renderBriefingHtml 的入参注释；HTML 是唯一产物形态（本地 file:// 直开，无外部依赖）。

/** HTML 转义：样音名、引擎注记都含用户可见文本，注入面在组装层一次收口 */
function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** 单格 = 同一引擎×语种下各嗓位一行：角色是矩阵第三维，塞进格内而不是砍掉 */
function cellHtml(samples) {
  const list = Array.isArray(samples) ? samples : [samples];
  const present = list.filter((sample) => sample && sample.exists);
  if (present.length === 0) {
    return `<td class="missing">缺采<span class="sub">${list.map((sample) => esc(sample?.voice ?? "?")).join(" / ")}</span></td>`;
  }
  const rows = present
    .map((sample) => {
      const dur = Number.isFinite(sample.durationS) ? ` ${sample.durationS.toFixed(2)}s` : "";
      return `<div class="voice-row"><audio controls preload="none" src="${esc(sample.file)}"></audio><span class="sub">${esc(sample.voice)}${dur}</span></div>`;
    })
    .join("\n");
  const missing = list
    .filter((sample) => !sample || !sample.exists)
    .map((sample) => `<span class="sub missing-note">${esc(sample?.voice ?? "?")} 缺采</span>`)
    .join("\n");
  return `<td>${rows}${missing}</td>`;
}

/**
 * 组装试听简报 HTML。
 * data 契约：
 *   generatedAt          ISO 时间串
 *   defaultChain         { zh: {engine,voice}, en: {engine,voice} } 当前内置表快照
 *   texts                { zh, en } 矩阵统一的试听文本
 *   engines              [{ name, hot, cold, verdict }] 蓝图裁决表摘要行
 *   rows                 [{ engine, cells: { zh: sample[], en: sample[] } }] 引擎×语种样音格，
 *                        每格是该语种下各嗓位的 sample 数组（角色=矩阵第三维），
 *                        sample = { file, exists, voice, durationS? }，file 相对 HTML 所在目录
 *   voices               [{ name, note }] 嗓位说明（default/frieren/dva 是什么）
 *   knownIssues          [string] 听感预期注记（IndexTTS 定长等实测现象）
 *   pendingDecisions     [string] 待用户裁决清单（ja 语种域等）
 */
export function renderBriefingHtml(data) {
  const engineRows = data.engines
    .map(
      (engine) =>
        `<tr><td>${esc(engine.name)}</td><td>${esc(engine.hot)}</td><td>${esc(engine.cold)}</td><td>${esc(engine.verdict)}</td></tr>`,
    )
    .join("\n");
  const voiceItems = data.voices.map((voice) => `<li><code>${esc(voice.name)}</code>：${esc(voice.note)}</li>`).join("\n");
  const matrixRows = data.rows
    .map(
      (row) => `<tr><th>${esc(row.engine)}</th>${cellHtml(row.cells.zh)}${cellHtml(row.cells.en)}</tr>`,
    )
    .join("\n");
  const issues = data.knownIssues.map((issue) => `<li>${esc(issue)}</li>`).join("\n");
  const pending = data.pendingDecisions.map((item) => `<li>${esc(item)}</li>`).join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>say 引擎 v2 默认裁决试听简报</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "PingFang SC", sans-serif; max-width: 72rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; border-bottom: 1px solid color-mix(in srgb, currentColor 20%, transparent); padding-bottom: .3rem; }
  table { border-collapse: collapse; width: 100%; margin: .8rem 0; }
  th, td { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); padding: .45rem .6rem; text-align: left; vertical-align: top; }
  td.missing { color: gray; } td .sub, td.missing .sub { display: block; font-size: .75rem; color: gray; }
  .voice-row { margin-bottom: .4rem; } .missing-note { color: gray; }
  audio { width: 16rem; max-width: 100%; display: block; }
  code { background: color-mix(in srgb, currentColor 10%, transparent); padding: .1rem .3rem; border-radius: 4px; }
  pre { background: color-mix(in srgb, currentColor 8%, transparent); padding: .8rem 1rem; border-radius: 8px; overflow-x: auto; }
  .chain { display: inline-block; margin: .2rem 1rem .2rem 0; padding: .5rem .9rem; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 8px; }
</style>
</head>
<body>
<h1>say 引擎 v2 默认裁决试听简报</h1>
<p>生成于 ${esc(data.generatedAt)}。当前默认链（config 内置表，voice="default" 关键字按系统语言自动落位）：</p>
<p>
  <span class="chain">zh → <code>${esc(data.defaultChain.zh.engine)}</code> + <code>${esc(data.defaultChain.zh.voice)}</code></span>
  <span class="chain">en → <code>${esc(data.defaultChain.en.engine)}</code> + <code>${esc(data.defaultChain.en.voice)}</code></span>
</p>

<h2>引擎裁决表（2026-10-06/07 M3 Max 实测）</h2>
<table>
  <tr><th>引擎</th><th>热（线 3s）</th><th>冷（线 10s）</th><th>裁决</th></tr>
  ${engineRows}
</table>

<h2>样音矩阵（四引擎 × 中英 × 三嗓）</h2>
<p>统一试听文本——zh：${esc(data.texts.zh)}；en：${esc(data.texts.en)}</p>
<table>
  <tr><th>引擎 \\ 语种</th><th>zh</th><th>en</th></tr>
  ${matrixRows}
</table>
<h3>嗓位说明</h3>
<ul>
  ${voiceItems}
</ul>

<h2>推荐与改判指引</h2>
<p>默认裁决：<code>gptsovits v2</code>（四引擎唯一中英热延迟双 PASS，角色资产零改造映射）。试听后不满意时改 config 一行即可改判（<code>~/.config/say/config.toml</code>）：</p>
<pre>engine = "voxcpm"      # 换默认引擎（可用值见 say engine ls）
voice = "default"      # 换默认嗓：default=按语言选引擎内置中性参考；角色嗓写 frieren-zh / dva 等</pre>
<p>两行都写时 voice 只在 engine 认领该嗓时生效（路由层仲裁），引擎与嗓不匹配会回退系统嗓并在 stderr 留一行原因。</p>

<h2>听感预期注记</h2>
<ul>
  ${issues}
</ul>

<h2>待决清单</h2>
<ul>
  ${pending}
</ul>
</body>
</html>
`;
}
