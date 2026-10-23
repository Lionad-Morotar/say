#!/usr/bin/env node
/**
 * 把试听裁决 report HTML 抽取为 manifest.json（嗓音工作台数据层的一次性迁移源）。
 * 纯函数 extractManifest(html) 无 IO，对拍测试与 CLI 共用；产物键序稳定，重跑零漂移。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 主矩阵 10 列的 (locale, voice token) 坐标，voice token 与样音文件名约定一致 */
const COLUMNS = [
  ["zh", "default"], ["zh", "frieren-zh"], ["zh", "dva"], ["zh", "lucy"],
  ["en", "default"], ["en", "frieren-en"], ["en", "dva"], ["en", "lucy"],
  ["ja", "default"], ["ja", "frieren"],
];

const decode = (s) =>
  s.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/&quot;/g, '"');

const textOf = (s) => decode(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

function section(html, startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  if (start === -1) throw new Error(`section 起点未找到: ${startMarker}`);
  const end = html.indexOf(endMarker, start);
  const body = end === -1 ? html.slice(start) : html.slice(start, end);
  return body;
}

function parseCell(td, engine, locale, voice) {
  const clsMatch = td.match(/^<td class="([^"]*)"/);
  const cls = clsMatch ? clsMatch[1] : "";
  const flags = cls.split(/\s+/).filter((f) => f !== "play" && f !== "");
  if (cls === "na" || (!cls.includes("play") && !cls.includes("await"))) {
    return { locale, voice, kind: "na", flags: [] };
  }
  if (cls.includes("await")) {
    const sub = td.match(/<span class="sub">([\s\S]*?)<\/span>/);
    return { locale, voice, kind: "await", note: sub ? textOf(sub[1]) : "", flags: [] };
  }
  const btn = td.match(/<button data-src="([^"]+)">([\s\S]*?)<\/button>/);
  if (!btn) throw new Error(`play 格缺 button: ${engine}/${locale}/${voice}`);
  const expected = `audio/${engine}-${locale}-${voice}.wav`;
  if (btn[1] !== expected) {
    throw new Error(`样音文件名与格子坐标不符: ${btn[1]} != ${expected}`);
  }
  const inner = btn[2];
  const sub = inner.match(/<span class="sub">([\s\S]*?)<\/span>/);
  const label = textOf(inner.replace(/<span class="sub">[\s\S]*?<\/span>/, ""));
  const cell = { locale, voice, kind: "play", audio: btn[1], label, flags };
  if (sub) cell.note = textOf(sub[1]);
  return cell;
}

function parseMatrix(tableHtml) {
  const rows = tableHtml.match(/<tr>[\s\S]*?<\/tr>/g) ?? [];
  const engines = [];
  for (const row of rows) {
    if (row.includes("<th")) continue;
    const tds = row.match(/<td[\s\S]*?<\/td>/g) ?? [];
    if (tds.length === 0) continue;
    const head = tds[0];
    const name = textOf((head.match(/<b>([\s\S]*?)<\/b>/) ?? [])[1] ?? "");
    const tag = textOf(((head.match(/<span class="sub">([\s\S]*?)<\/span>/) ?? [])[1] ?? ""));
    if (!name) throw new Error(`引擎行缺名字: ${row.slice(0, 80)}`);
    if (tds.length !== 11) throw new Error(`${name} 列数 ${tds.length - 1} != 10`);
    const cells = tds.slice(1).map((td, i) => parseCell(td, name, COLUMNS[i][0], COLUMNS[i][1]));
    engines.push({ name, tag, cells });
  }
  return engines;
}

function parseRows(tableHtml, fields) {
  const rows = (tableHtml.match(/<tr>[\s\S]*?<\/tr>/g) ?? []).filter((r) => !r.includes("<th"));
  return rows.map((row) => {
    const tds = row.match(/<td[^>]*>([\s\S]*?)<\/td>/g) ?? [];
    const entry = {};
    fields.forEach((f, i) => {
      entry[f] = tds[i] !== undefined ? textOf(tds[i].replace(/^<td[^>]*>/, "").replace(/<\/td>$/, "")) : "";
    });
    return entry;
  });
}

function parseDivs(sectionHtml, className) {
  const divs = sectionHtml.match(new RegExp(`<div class="${className}">[\\s\\S]*?</div>`, "g")) ?? [];
  return divs.map((d) => textOf(d.replace(/^<div[^>]*>/, "").replace(/<\/div>$/, "")));
}

function parseVerdicts(sectionHtml) {
  return parseDivs(sectionHtml, "fixed").map((text) => {
    const m = text.match(/^(\w+) → (\w+) \+ ([^:：]+)[:：]([\s\S]*)$/);
    if (!m) throw new Error(`裁决段解析失败: ${text.slice(0, 50)}`);
    return { key: m[1], engine: m[2], voice: m[3].trim(), reason: m[4].trim() };
  });
}

/** 裁决段的嗓位是叙述短语（如「内置女声参考」），canonical token 以主矩阵 winner 格为准 */
function canonicalizeVerdictVoices(verdicts, engines) {
  for (const v of verdicts) {
    const winners = (engines.find((e) => e.name === v.engine) ?? { cells: [] }).cells.filter(
      (c) => c.flags.includes("winner") && c.locale === v.key,
    );
    if (winners.length !== 1) {
      throw new Error(`裁决 ${v.key} 在 ${v.engine} 无唯一 winner 格（得 ${winners.length}）`);
    }
    v.voice = winners[0].voice;
  }
  return verdicts;
}

export function extractManifest(html) {
  const engines = parseMatrix(section(html, '<table data-testid="voice-matrix">', "</table>"));
  const genderTable = parseRows(
    section(html, "嗓位性别 × 音源", "</table>"),
    ["voice", "gender", "basis", "source"],
  );
  const engineProps = parseRows(
    section(html, "引擎属性（延迟 × 形态 × ja × 安装）", "</table>"),
    ["engine", "latency", "form", "ja", "install"],
  );
  const verdicts = canonicalizeVerdictVoices(
    parseVerdicts(section(html, "试听裁决（人听定档", "<!--")),
    engines,
  );
  const fixRecords = parseDivs(section(html, "261007 修复记录（Lionad 试听驱动）", "<!--"), "fixed");
  const openItems = parseDivs(section(html, "未决项", "</body>"), "gap");

  const h1 = html.match(/<h1>([\s\S]*?)<small>([\s\S]*?)<\/small><\/h1>/);
  if (!h1) throw new Error("h1 标题解析失败");
  const summaryP = html.match(/<p>2026-10-07 归档。([\s\S]*?)<\/p>/);

  return {
    date: "261007",
    source: "engine-v2-voice-matrix.html",
    title: textOf(h1[1]),
    edition: textOf(h1[2]),
    summary: summaryP ? textOf(`2026-10-07 归档。${summaryP[1]}`) : "",
    verdicts,
    engines,
    genderTable,
    engineProps,
    fixRecords,
    openItems,
  };
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const dateDir = resolve(here, "../docs/audition/261007");
  const html = readFileSync(resolve(dateDir, "engine-v2-voice-matrix.html"), "utf8");
  const manifest = extractManifest(html);
  const out = resolve(dateDir, "manifest.json");
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  const plays = manifest.engines.flatMap((e) => e.cells).filter((c) => c.kind === "play");
  console.log(`manifest 写入 ${out}：${manifest.engines.length} 引擎，play ${plays.length} 格`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
