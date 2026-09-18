#!/usr/bin/env node
// 一键跑分器入口。模式：--setup 资产落地（幂等）、--bench 跑矩阵、--report 生成报告、--verify 证据链对账。
// 证据链契约：所有真实执行（安装/下载/合成）经 lib/log.mjs 落 raw-log.jsonl，报告数字只从 log 聚合。
import { ensureAssets } from "./lib/assets.mjs";
import { ALL_CHANNELS } from "./lib/channels.mjs";
import { generateReport } from "./lib/report.mjs";
import { runBench } from "./lib/runner.mjs";
import { verify } from "./lib/verify.mjs";

const argv = process.argv.slice(2);
const args = new Set();
let only;

// --only 拼错若静默跳过全部通道，操作者会误信本轮已跑完；解析失败必须显式报错退出
function failOnly(msg) {
  console.error(msg);
  process.exit(2);
}

function parseOnly(raw) {
  const list = raw.split(",").filter(Boolean);
  // 支持 engine 与 engine:channel 两种粒度：同 engine 双通道（spawn/node）时可单跑其一，
  // 避免重跑已测通道——append-only 日志下热缓存复跑会产出误标 cold 的稀释数据
  const known = new Set(ALL_CHANNELS.flatMap((c) => [c.engine, `${c.engine}:${c.channel}`]));
  const unknown = list.filter((e) => !known.has(e));
  if (list.length === 0 || unknown.length > 0) {
    failOnly(`未知 engine 或 engine:channel: ${unknown.join(", ") || "(空)"}（已知: ${[...known].join(", ")}）`);
  }
  return list;
}

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--only") {
    const v = argv[++i];
    if (!v || v.startsWith("--")) failOnly("--only 需要 engine 值，如 --only=system-say 或 --only system-say");
    only = parseOnly(v);
  } else if (a.startsWith("--only=")) {
    only = parseOnly(a.slice("--only=".length));
  } else {
    args.add(a);
  }
}

async function main() {
  if (args.has("--setup")) {
    const started = Date.now();
    const { ok, failures } = await ensureAssets();
    const summary = { ok, failures, elapsed_s: Math.round((Date.now() - started) / 1000) };
    console.log(JSON.stringify(summary, null, 2));
    process.exit(ok ? 0 : 1);
  }
  if (args.has("--bench")) {
    const started = Date.now();
    const results = await runBench({ channels: ALL_CHANNELS, only });
    // 单格失败不置非零退出码：失败已如实落 raw-log，判定归 verify 与报告，runner 只报执行面
    console.log(JSON.stringify({ results, elapsed_s: Math.round((Date.now() - started) / 1000) }, null, 2));
    process.exit(0);
  }
  if (args.has("--report")) {
    const r = await generateReport();
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  }
  if (args.has("--verify")) {
    const r = await verify();
    for (const c of r.checks) console.log(`${c.status === "PASS" ? "✓" : "✗"} ${c.name}: ${c.detail}`);
    console.log(JSON.stringify({ ok: r.ok, cells: r.cells, unavailable: r.unavailable, na_cells: r.naCells }));
    process.exit(r.ok ? 0 : 1);
  }
  console.error("用法: node bench/run.mjs --setup | --bench [--only=engine[:channel],…] | --report | --verify");
  process.exit(2);
}

main();
