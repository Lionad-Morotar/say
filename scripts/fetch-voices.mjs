#!/usr/bin/env node
// 角色参考音频采集管线入口（s-voicepack）。
// 模式：默认 = 采集+处理+转写+验证+冒烟（幂等：达标资产跳过）；--verify = 只审计不下载。
// 证据链契约：所有真实执行（下载/处理/转写/合成）落 docs/research/voicepack/raw-log.jsonl，
// 报告数字只从该日志聚合；skip 不入日志。
import path from "node:path";
import { CHARACTERS, MANIFEST } from "./lib/manifest.mjs";
import { VOICES_DIR, VOICEPACK_DOCS, RAW_LOG } from "./lib/config.mjs";
import { assessCharacter, assessSmokeDuration, measureWav } from "./lib/verify.mjs";

const argv = process.argv.slice(2);
const verifyOnly = argv.includes("--verify");
const onlyIdx = argv.indexOf("--only");
let only = null;
if (onlyIdx >= 0) {
  only = argv[onlyIdx + 1];
  // 缺参不得静默退化为全集——那会把「只审计一个角色」的意图放大成三角色全量下载/合成
  if (!only || only.startsWith("--")) {
    console.error(`--only 需要角色值，如 --only dva（已知: ${CHARACTERS.join(", ")}）`);
    process.exit(2);
  }
  if (!CHARACTERS.includes(only)) {
    console.error(`未知角色: ${only}（已知: ${CHARACTERS.join(", ")}）`);
    process.exit(2);
  }
}
const targets = only ? [only] : CHARACTERS;

async function verifyAll() {
  let allOk = true;
  const rows = [];
  for (const c of targets) {
    const dir = path.join(VOICES_DIR, c);
    const r = await assessCharacter(dir);
    const smokeFile = path.join(VOICEPACK_DOCS, `smoke-${c}.wav`);
    const smokeDur = (await measureWav(smokeFile))?.durationS ?? null;
    const smoke = assessSmokeDuration(smokeDur);
    const ok = r.complete && smoke.ok;
    if (!ok) allOk = false;
    rows.push({
      character: c,
      asset: r.complete ? "PASS" : "FAIL",
      afinfo: r.afinfo,
      peak_db: r.maxVolumeDb,
      smoke: smoke.ok ? `PASS(${smokeDur}s)` : `FAIL(${smokeDur ?? "缺失"})`,
      reasons: [...r.reasons, ...(smoke.ok ? [] : smoke.reasons.map((x) => `smoke ${x}`))],
    });
  }
  console.log(JSON.stringify({ raw_log: RAW_LOG, results: rows }, null, 2));
  process.exit(allOk ? 0 : 1);
}

if (verifyOnly) {
  await verifyAll();
} else {
  const hasCandidates = targets.some((c) => MANIFEST[c].candidates.length > 0);
  if (!hasCandidates) {
    console.error(`角色 ${targets.join(", ")} 暂无素材候选（manifest 为空）；可用 --verify 审计资产状态`);
    process.exit(2);
  }
  const { runPipeline } = await import("./lib/pipeline.mjs");
  await runPipeline(targets);
}
