#!/usr/bin/env node
// 一键跑分器入口。模式：--setup 资产落地（幂等），跑分与 --verify 对账模式随通道适配器就位后启用。
// 证据链契约：所有真实执行（安装/下载/合成）经 lib/log.mjs 落 raw-log.jsonl，报告数字只从 log 聚合。
import { ensureAssets } from "./lib/assets.mjs";

const args = new Set(process.argv.slice(2));

async function main() {
  if (args.has("--setup")) {
    const started = Date.now();
    const { ok, failures } = await ensureAssets();
    const summary = { ok, failures, elapsed_s: Math.round((Date.now() - started) / 1000) };
    console.log(JSON.stringify(summary, null, 2));
    process.exit(ok ? 0 : 1);
  }
  console.error("用法: node bench/run.mjs --setup");
  process.exit(2);
}

main();
