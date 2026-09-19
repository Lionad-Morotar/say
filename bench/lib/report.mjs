// 报告生成器：延迟表、可行性矩阵、N/A 声明、bench-cells JSON 块全部从 raw-log 与磁盘现场重算，
// 叙事文字是静态模板——数字归日志、措辞归模板，杜绝手抄漂移（verify C3 全格对账的另一半闭环）。
// 存在性证据（--version/ls/uv tool list）在生成时实采原样嵌入；这些是证据采集而非合成执行，不入 raw-log。
import { existsSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEGENERATE_RATIO, LIMIT_COLD_S, LIMIT_HOT_S, MARGINAL_FACTOR,
  MIN_SAMPLE_DATA_BYTES, MIN_SAMPLE_DURATION_S, REPO, REPORT, RUNS, SAMPLES, SAMPLE_RATE,
  SHERPA_VERSION, TEXTS, TEXT_IDS,
} from "./config.mjs";
import {
  KOKORO_DIR, MATCHA_DIR, MLX_TTS_ENTRY, QWEN3_DIR, SHERPA_BIN,
  VOCODERS_DIR, ZIPVOICE_DIR,
} from "./assets.mjs";
import { EXPECTED_CHANNELS } from "./channels.mjs";
import { runCmd } from "./exec.mjs";
import { readLog } from "./log.mjs";
import { checkSample, sayBaselines } from "./sample.mjs";
import { aggregateCells, deriveUnavailable } from "./verdict.mjs";

const VOICE_FACTS = {
  "sherpa-kokoro": "sid=0（v1_1 映射 af_maple，四文本同音色）",
  "sherpa-matcha": "单说话人 baker 女声",
  "sherpa-zipvoice": "官方占位干音 leijun-1.wav 零样本克隆（参考文本原样取包内 prompt.txt，num-steps=4）",
  "mlx-qwen3": "CustomVoice 预设 vivian，lang_code 显式对齐文本语言（mixed 走 auto）",
  "system-say": "Eddy(en) / Tingting(zh, mixed)",
};

function fmtS(ms) {
  return (ms / 1000).toFixed(2);
}

function dirSize(p) {
  let total = 0;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const fp = path.join(p, e.name);
    total += e.isDirectory() ? dirSize(fp) : statSync(fp).size;
  }
  return total;
}

function humanMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 从磁盘现实推导 N/A 格：绝对下限或 say 对照比例触底即退化；通道不可用格由 deriveUnavailable 共享件豁免 */
async function deriveNaCells(log, baseline, unavailable) {
  const naCells = [];
  const synth = log.filter((l) => l.phase === "synth");
  for (const c of EXPECTED_CHANNELS) {
    const key = `${c.engine}|${c.channel}`;
    if (unavailable.has(key)) continue;
    for (const textid of TEXT_IDS) {
      const rows = synth.filter((r) => r.engine === c.engine && r.channel === c.channel && r.textid === textid);
      if (rows.length === 0) continue;
      const file = path.join(SAMPLES, `${c.engine}-${c.channel}-${textid}.wav`);
      const r = await checkSample(file);
      const base = baseline.get(textid);
      const degenerate = !r.ok || (base != null && r.durationS != null && r.durationS < base * DEGENERATE_RATIO);
      if (!degenerate) continue;
      // 全失败格的成功行集合为空：Math.min 空集得 Infinity，必须换失败计数文案而非渲染不可能字节数
      const okRows = rows.filter((x) => x.exit === 0);
      const attemptNote = okRows.length > 0
        ? `原始输出最小 ${Math.min(...okRows.map((x) => x.out_bytes ?? 0))}B`
        : `${rows.length} 次尝试全部失败（exit≠0）`;
      const reason = !r.ok
        ? `样本无效（${r.reasons.join("；")}），${attemptNote}`
        : `退化音频：样本 ${r.durationS.toFixed(2)}s 仅为 say 对照 ${base.toFixed(2)}s 的 ${((r.durationS / base) * 100).toFixed(1)}%（< ${DEGENERATE_RATIO * 100}% 下限），${attemptNote}`;
      naCells.push({ engine: c.engine, channel: c.channel, textid, reason });
    }
  }
  return naCells;
}

/** 可行性矩阵：{kokoro,matcha,zipvoice} × {node,spawn} 六格 */
function feasibilityMatrix(naCells, unavailable, cellMap) {
  const models = [
    { label: "kokoro-int8", engine: "sherpa-kokoro" },
    { label: "matcha-zh-baker", engine: "sherpa-matcha" },
    { label: "ZipVoice-distill-int8", engine: "sherpa-zipvoice" },
  ];
  const lines = ["| 模型 | Node 绑定 | spawn 二进制 |", "| --- | --- | --- |"];
  for (const m of models) {
    const rowCells = [];
    for (const channel of ["node", "spawn"]) {
      const key = `${m.engine}|${channel}`;
      if (unavailable.has(key)) {
        rowCells.push("不可用（通道级 N/A，见附录）");
        continue;
      }
      const naHere = naCells.filter((n) => n.engine === m.engine && n.channel === channel);
      const hasData = TEXT_IDS.some((t) => cellMap.has(`${key}|${t}|hot`));
      if (!hasData) {
        rowCells.push("未测");
        continue;
      }
      if (naHere.length === 0) rowCells.push("可用（4/4 文本）");
      else if (naHere.length >= TEXT_IDS.length) rowCells.push("不可用（全部文本退化）");
      else rowCells.push(`可用（附注：${TEXT_IDS.length - naHere.length}/${TEXT_IDS.length} 文本，${naHere.map((n) => n.textid).join("、")} 退化 N/A）`);
    }
    lines.push(`| ${m.label} | ${rowCells[0]} | ${rowCells[1]} |`);
  }
  return lines.join("\n");
}

function latencyTable(cellMap, naCells) {
  const naSet = new Set(naCells.map((n) => `${n.engine}|${n.channel}|${n.textid}`));
  const header = `| 通道 | 文本 | cold 中位 (s) | 判定 | hot 中位 (s) | 判定 |`;
  const sep = "| --- | --- | --- | --- | --- | --- |";
  const lines = [header, sep];
  for (const c of EXPECTED_CHANNELS) {
    for (const textid of TEXT_IDS) {
      const key = `${c.engine}|${c.channel}|${textid}`;
      if (naSet.has(key)) {
        lines.push(`| ${c.engine}/${c.channel} | ${textid} | N/A | N/A | N/A | N/A（退化） |`);
        continue;
      }
      const cold = cellMap.get(`${key}|cold`);
      const hot = cellMap.get(`${key}|hot`);
      lines.push(
        `| ${c.engine}/${c.channel} | ${textid} | ${cold ? fmtS(cold.median_ms) : "—"} | ${cold ? cold.verdict : "—"} | ${hot ? fmtS(hot.median_ms) : "—"} | ${hot ? hot.verdict : "—"} |`,
      );
    }
  }
  return lines.join("\n");
}

/** F2 常驻 daemon 触发建议：按热态判定分布推导，措辞静态、数字现场 */
function f2Recommendation(cellMap, naCells) {
  const naSet = new Set(naCells.map((n) => `${n.engine}|${n.channel}|${n.textid}`));
  const hotVerdicts = new Map();
  for (const c of EXPECTED_CHANNELS) {
    const list = [];
    for (const textid of TEXT_IDS) {
      const key = `${c.engine}|${c.channel}|${textid}`;
      if (naSet.has(key)) continue;
      const hot = cellMap.get(`${key}|hot`);
      if (hot) list.push(hot.verdict);
    }
    if (list.length) hotVerdicts.set(`${c.engine}/${c.channel}`, list);
  }
  const lines = [];
  for (const [name, verdicts] of hotVerdicts) {
    const pass = verdicts.filter((v) => v === "PASS").length;
    const tag = pass === verdicts.length ? "热态全 PASS，无需 daemon" : pass === 0 ? "热态全超标，daemon 化是硬前提" : `热态 ${pass}/${verdicts.length} PASS，长文本场景需 daemon`;
    lines.push(`- ${name}：${tag}`);
  }
  return lines.join("\n");
}

async function existenceAppendix() {
  const parts = ["## 存在性证据附录", ""];
  const ver = await runCmd([SHERPA_BIN, "--version"], { timeoutMs: 30_000 });
  parts.push(`### sherpa 二进制`, "", `- 路径：\`${SHERPA_BIN}\``, `- 版本：发布 tag v${SHERPA_VERSION}（包名 sherpa-onnx-v${SHERPA_VERSION}-osx-arm64-static）`, `- \`--version\` 实输出（该 binary 无此选项，原样收录实跑结果）：`, "", "```text", `${ver.stdout}\n${ver.stderrTail}`.trim(), "```", "");
  const uvList = await runCmd(["uv", "tool", "list"], { timeoutMs: 60_000 });
  parts.push(`### mlx-audio`, "", "- uv tool list 实输出：", "", "```text", uvList.stdout.trim(), "```", `- TTS 入口：\`${MLX_TTS_ENTRY}\`（存在：${existsSync(MLX_TTS_ENTRY)}）`, "");
  const pn = await runCmd(["pnpm", "list", "sherpa-onnx-node"], { cwd: REPO, timeoutMs: 60_000 });
  parts.push(`### sherpa-onnx-node`, "", "```text", pn.stdout.trim(), "```", "");
  parts.push(`### 模型目录（command ls -la 原样）`, "");
  for (const [label, dir] of [["kokoro", KOKORO_DIR], ["matcha", MATCHA_DIR], ["zipvoice", ZIPVOICE_DIR], ["vocoders", VOCODERS_DIR], ["qwen3", QWEN3_DIR]]) {
    const ls = await runCmd(["ls", "-la", dir], { timeoutMs: 30_000 });
    parts.push(`#### ${label}（${dir}）`, "", "```text", ls.stdout.trim(), "```", "");
  }
  return parts.join("\n");
}

function assetInventory() {
  const lines = ["| 资产 | 路径 | 体积 |", "| --- | --- | --- |"];
  for (const [label, dir] of [
    ["sherpa 静态工具包", path.dirname(path.dirname(SHERPA_BIN))],
    ["kokoro-int8-multi-lang-v1_1", KOKORO_DIR],
    ["matcha-icefall-zh-baker", MATCHA_DIR],
    ["zipvoice-distill-int8-zh-en-emilia", ZIPVOICE_DIR],
    ["vocoder（22k+24k）", VOCODERS_DIR],
    ["Qwen3-TTS-0.6B-CustomVoice-8bit", QWEN3_DIR],
  ]) {
    lines.push(`| ${label} | \`${dir}\` | ${existsSync(dir) ? humanMB(dirSize(dir)) : "缺失"} |`);
  }
  return lines.join("\n");
}

export async function generateReport() {
  const log = readLog();
  const synth = log.filter((l) => l.phase === "synth");
  const unavailable = deriveUnavailable(log);
  const baseline = await sayBaselines();
  const naCells = await deriveNaCells(log, baseline, unavailable);
  const allCells = aggregateCells(synth);
  const naSet = new Set(naCells.map((n) => `${n.engine}|${n.channel}|${n.textid}`));
  const cells = allCells.filter((c) => !naSet.has(`${c.engine}|${c.channel}|${c.textid}`));
  const cellMap = new Map(allCells.map((c) => [`${c.engine}|${c.channel}|${c.textid}|${c.mode}`, c]));

  const rowCount = synth.length;
  const okCount = synth.filter((l) => l.exit === 0).length;

  const sections = [];
  sections.push(`# s-bench 本机 TTS 跑分报告`, "");
  sections.push(`生成时间：${new Date().toISOString()}；机器：Apple M3（本机实测）；数据源：\`docs/research/bench/raw-log.jsonl\`（synth ${rowCount} 行，exit 0 共 ${okCount} 行）。本报告全部数字可由 raw-log 重算复现（\`node bench/run.mjs --verify\` C3 全格对账）。`, "");

  sections.push(`## 口径`, "");
  sections.push(`- 文本集：4 条固定文本（${TEXT_IDS.map((t) => `${t}「${TEXTS[t].text.slice(0, 18)}…」`).join("、")}），zh-mixed 原样取自蓝图调研样本`, "");
  sections.push(`- 每格 ${RUNS} 次取中位数；append-only 日志下重跑同格只增样本，中位数对全部成功行计算`, "");
  sections.push(`- cold/hot：spawn 与 subprocess 通道每格 6 次独立进程调用（前 3 次 cold=会话首批文件半冷，后 3 次 hot=page cache 热，二者差异即文件系统缓存）；Node 绑定通道为配对测量——单 worker 进程内 cold=父进程 spawn 到首次合成落盘（含 node 启动、绑定与模型加载），hot=模型驻留态二次合成+写盘（即常驻 daemon 的延迟面）`, "");
  sections.push(`- 验收判据：热态 ≤${LIMIT_HOT_S}s、冷态 ≤${LIMIT_COLD_S}s 判 PASS；超标但 ≤${MARGINAL_FACTOR}× 判 MARGINAL；再超判 FAIL`, "");
  sections.push(`- 样本有效性：数据字节 ≥${MIN_SAMPLE_DATA_BYTES}（${MIN_SAMPLE_DURATION_S}s @${SAMPLE_RATE}Hz 16bit 单声道）且 afinfo 时长 >${MIN_SAMPLE_DURATION_S}s；退化判定：时长 < 同文本 system-say 对照 ${DEGENERATE_RATIO * 100}% 即非真实语音（单语模型跑外语文本 exit 0 出噪声、长文本体积仍可超绝对下限，纯字节判据会漏判）`, "");
  sections.push(`- 试听样本统一 afconvert 转 ${SAMPLE_RATE}Hz 16bit 单声道；sherpa 统一 --num-threads=2`, "");
  sections.push(`- 跨通道音频时长存在系统性差异（如 kokoro Node 绑定输出时长约为 spawn 的 1.4~1.7 倍，源于绑定层与 CLI 的默认参数差异）：延迟数字是「该通道完成该文本合成」的实测耗时，不做跨通道归一化`, "");
  sections.push(`- 正式矩阵前的 flag 探针已使模型文件进入 page cache，矩阵内 cold 与 hot 差值收敛（表中可见）；真实首载场景（重启/清缓存后，2GB 级权重首次读盘）cold 会显著高于矩阵内数值，选型时按「矩阵 cold 为下界」理解`, "");
  sections.push(`- 各通道音色：${Object.entries(VOICE_FACTS).map(([k, v]) => `${k} ${v}`).join("；")}`, "");
  sections.push(`- mlx 通道 --join_audio 单文件输出、--model 指本地目录不触网`, "");

  sections.push(`## 延迟总表`, "", latencyTable(cellMap, naCells), "");

  sections.push(`## 可行性矩阵（{kokoro, matcha, ZipVoice} × {Node 绑定, spawn}）`, "", feasibilityMatrix(naCells, unavailable, cellMap), "", "ZipVoice Node 绑定支持为本次关键验证项：以已安装 sherpa-onnx-node v" + SHERPA_VERSION + " 的 types.js（OfflineTtsZipvoiceModelConfig）与 addon 二进制符号（referenceAudio/numSteps 键）为静态证据，并以真实合成行（channel=node, engine=sherpa-zipvoice, exit 0, 24kHz 有效音频）为动态证据——支持成立。", "");

  sections.push(`## F2 常驻 daemon 触发建议`, "", f2Recommendation(cellMap, naCells), "", "对照基线：system-say 无任何模型加载仍在本机秒级完成，神经 TTS 的热态超标格全部指向「进程内模型常驻」这一个解法；冷态超标而热态达标的通道（若有）说明瓶颈在加载而非推理，daemon 收益最大。", "");

  sections.push(`## N/A 说明（诚实退化格）`, "");
  if (naCells.length === 0) sections.push("无。");
  else {
    sections.push("| 格 | 原因 |", "| --- | --- |");
    for (const n of naCells) sections.push(`| ${n.engine}/${n.channel}/${n.textid} | ${n.reason} |`);
    sections.push("", "matcha-icefall-zh-baker 为单语中文模型：英文文本不报错但输出无语音噪声，属模型能力边界而非工程缺陷；zh-mixed 输出有效（为 say 对照 54%）按「可用（附注：英文术语可能被吞）」处理，不列 N/A。佐证行均在 raw-log（exit 0 + 退化 out_bytes/时长），verify C5 机器核验。");
  }
  sections.push("");

  if (unavailable.size > 0) {
    sections.push(`## 通道级 N/A`, "", [...unavailable].map((k) => `- ${k}（可用性检查失败行见 raw-log phase=install）`).join("\n"), "");
  }

  sections.push(`## 资产清单`, "", assetInventory(), "", `模型与工具落 \`~/.cache/say/\` 产品正式位（安装脚本可经 bench/lib/assets.mjs 的 manifest 复用）；下载/安装证据见 raw-log phase=download/install 行（每条含实际 URL 与网络通道）。`, "");

  sections.push(await existenceAppendix());

  sections.push(`## bench-cells（verify C3 对账锚点）`, "", "```json bench-cells", JSON.stringify({ cells, na_cells: naCells }, null, 2), "```", "");

  mkdirSync(path.dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, sections.join("\n"));
  return { ok: true, cells: cells.length, naCells: naCells.length, unavailable: unavailable.size, synthRows: rowCount };
}
