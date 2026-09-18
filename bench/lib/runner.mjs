// 矩阵执行器：通道 × 文本 × 冷/热 × runs。
// cold/hot 口径：spawn 系通道每格 6 次独立调用——前 3 次标 cold（会话首批，文件半冷）、
// 后 3 次标 hot（page cache 热）；paired 通道（Node 绑定）单次 worker 进程内产出 cold+hot 两行。
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { BENCH_DOCS, RUNS, SAMPLES, TEXT_IDS, TEXTS } from "./config.mjs";
import { logLine, nowIso } from "./log.mjs";
import { convertToSample } from "./sample.mjs";

export const RAW_DIR = path.join(BENCH_DOCS, "raw");

/**
 * @param {{channels: Array, only?: string[]}} opts
 * @returns {Promise<Array<{engine: string, channel: string, status: string, reason?: string}>>}
 */
export async function runBench({ channels, only }) {
  mkdirSync(RAW_DIR, { recursive: true });
  mkdirSync(SAMPLES, { recursive: true });
  const results = [];
  for (const ch of channels) {
    if (only && !only.some((o) => o === ch.engine || o === `${ch.engine}:${ch.channel}`)) continue;
    const av = await ch.available();
    if (!av.ok) {
      // 通道级 N/A：install 相失败行留证，本通道全部合成豁免
      const ts = nowIso();
      logLine({
        ts, phase: "install", engine: ch.engine, channel: ch.channel,
        model: ch.model ?? ch.engine, textid: null, run: null, mode: null,
        cmd: av.cmd ?? "availability-check", exit: 1, started: ts, ended: ts,
        duration_ms: 0, out_file: null, out_bytes: null, stderr_tail: av.reason,
      });
      results.push({ engine: ch.engine, channel: ch.channel, status: "unavailable", reason: av.reason });
      continue;
    }
    const issues = [];
    for (const textid of TEXT_IDS) {
      const invocations = ch.paired ? RUNS : RUNS * 2;
      let sampleSource = null;
      for (let inv = 1; inv <= invocations; inv++) {
        const mode = ch.paired ? null : inv <= RUNS ? "cold" : "hot";
        const run = ch.paired ? inv : ((inv - 1) % RUNS) + 1;
        const rawBase = path.join(RAW_DIR, `${ch.engine}-${ch.channel}-${textid}-${mode ?? "pair"}-r${run}`);
        const { rows } = await ch.measure({ textid, text: TEXTS[textid].text, rawPath: rawBase, run });
        for (const m of rows) {
          logLine({
            ts: nowIso(), phase: "synth", engine: ch.engine, channel: ch.channel,
            model: m.model ?? ch.model ?? null, textid,
            run: m.run ?? run, mode: m.mode ?? mode,
            cmd: m.cmdStr, exit: m.exit, started: m.started, ended: m.ended,
            duration_ms: m.durationMs, out_file: m.outFile, out_bytes: m.outBytes,
            stderr_tail: m.stderrTail,
          });
          // 试听样本取首个成功输出（迭代序保证 = cold r1；失败格顺延到任一成功 run）
          if (!sampleSource && m.exit === 0 && m.outFile && existsSync(m.outFile)) sampleSource = m.outFile;
        }
      }
      if (sampleSource) {
        const conv = await convertToSample(sampleSource, ch.engine, ch.channel, textid);
        if (!conv.ok) issues.push({ textid, status: "convert-failed", reason: conv.stderrTail });
      } else {
        issues.push({ textid, status: "no-sample", reason: "无成功合成输出" });
      }
    }
    // 通道收尾态与明细一致：有转制/无样本问题标 partial 并带 textid 定位，不再自相矛盾报 done
    results.push({ engine: ch.engine, channel: ch.channel, status: issues.length === 0 ? "done" : "partial", issues });
  }
  return results;
}
