// raw-log 读写：证据链的唯一真源。每行一次真实执行，schema 见下方 LogEntry typedef。
// append-only：重跑同格只增加样本数，聚合取中位数天然兼容独立对账（报告数字必须可由本文件重算）。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { RAW_LOG } from "./config.mjs";

/**
 * @typedef {Object} LogEntry
 * @property {string} ts ISO 时间戳
 * @property {"install"|"download"|"synth"} phase
 * @property {string} engine 引擎/资产归属（sherpa-kokoro|sherpa-matcha|sherpa-zipvoice|mlx-qwen3|system-say|sherpa-tooling|mlx-audio|npm）
 * @property {"spawn"|"node"|"subprocess"|null} channel 合成执行通道；install/download 相为 null
 * @property {string|null} model
 * @property {string|null} textid
 * @property {number|null} run 1-3
 * @property {"cold"|"hot"|null} mode
 * @property {string} cmd 完整命令行（可原样复跑）
 * @property {number|null} exit
 * @property {string} started
 * @property {string} ended
 * @property {number} duration_ms
 * @property {string|null} out_file
 * @property {number|null} out_bytes
 * @property {string} stderr_tail
 */

/** download/install 相可附加扩展字段（如网络通道、URL），对账聚合只读 synth 相，不受影响 */
export function logLine(entry) {
  mkdirSync(path.dirname(RAW_LOG), { recursive: true });
  appendFileSync(RAW_LOG, JSON.stringify(entry) + "\n");
}

/** @returns {LogEntry[]} */
export function readLog() {
  if (!existsSync(RAW_LOG)) return [];
  return readFileSync(RAW_LOG, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

export function nowIso() {
  return new Date().toISOString();
}
