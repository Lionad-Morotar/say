// voicepack 证据链日志：schema 沿 bench raw-log 字段名（ts/phase/cmd/exit/duration_ms/...），
// phase 扩展 download/process/transcribe/synth/install。append-only：只收真实执行，
// 幂等 skip 不入日志（否则重跑污染「每行一次真实执行」语义）。
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { nowIso } from "../../bench/lib/log.mjs";

/**
 * @param {string} file raw-log.jsonl 绝对路径
 * @param {{phase:"download"|"process"|"transcribe"|"synth"|"install", engine:string, cmd:string,
 *   exit:number|null, started:string, ended:string, durationMs:number,
 *   outFile:string|null, outBytes:number|null, stderrTail:string, url?:string}} e
 */
export function appendVoiceLog(file, e) {
  mkdirSync(path.dirname(file), { recursive: true });
  const line = {
    ts: nowIso(),
    phase: e.phase,
    engine: e.engine,
    cmd: e.cmd,
    exit: e.exit,
    started: e.started,
    ended: e.ended,
    duration_ms: e.durationMs,
    out_file: e.outFile,
    out_bytes: e.outBytes,
    stderr_tail: e.stderrTail,
    ...(e.url != null ? { url: e.url } : {}),
  };
  appendFileSync(file, JSON.stringify(line) + "\n");
}
