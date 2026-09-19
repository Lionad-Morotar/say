// 判定口径（共享件）：verify 对账与 report 生成必须用同一函数，杜绝两处实现漂移。
import { LIMIT_COLD_S, LIMIT_HOT_S, MARGINAL_FACTOR } from "./config.mjs";

/** @param {number[]} nums @returns {number} 中位数（偶数个取中间两数均值；runs=3 取中间值） */
export function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * polaris 判据：热 ≤3s / 冷 ≤10s → PASS；超标但 ≤1.5× → MARGINAL（系数口径须在报告口径节声明）；>1.5× → FAIL。
 * @param {number} medianMs
 * @param {"cold"|"hot"} mode
 * @returns {"PASS"|"MARGINAL"|"FAIL"}
 */
export function verdictOf(medianMs, mode) {
  const limitMs = (mode === "hot" ? LIMIT_HOT_S : LIMIT_COLD_S) * 1000;
  if (medianMs <= limitMs) return "PASS";
  return medianMs <= limitMs * MARGINAL_FACTOR ? "MARGINAL" : "FAIL";
}

/**
 * 通道级可用性推导（共享件：verify 与 report 必须同一实现，杜绝两处口径漂移）。
 * 凭 runner 可用性失败行（phase=install, exit≠0, textid=null, channel 非空）判定，带时序撤销：
 * append-only 日志下取每通道最后一个状态行，失败行之后出现 synth 行即视为已恢复、不再豁免；
 * 资产落地的 install 行（channel=null）属 setup 面，不参与通道判定。
 * @param {Array} log raw-log 全部行
 * @returns {Set<string>} 不可用通道键（engine|channel）集合
 */
export function deriveUnavailable(log) {
  const lastState = new Map();
  for (const l of log) {
    if (l.channel == null) continue;
    const key = `${l.engine}|${l.channel}`;
    if (l.phase === "install" && l.exit !== 0 && l.textid == null) lastState.set(key, "fail");
    else if (l.phase === "synth") lastState.set(key, "synth");
  }
  return new Set([...lastState].filter(([, s]) => s === "fail").map(([k]) => k));
}

/** 按 (engine, channel, textid, mode) 聚合 synth 成功行 → 中位数格 */
export function aggregateCells(synthRows) {
  const by = new Map();
  for (const r of synthRows) {
    if (r.exit !== 0) continue;
    const key = `${r.engine}|${r.channel}|${r.textid}|${r.mode}`;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(r.duration_ms);
  }
  const cells = [];
  for (const [key, durations] of by) {
    const [engine, channel, textid, mode] = key.split("|");
    const med = median(durations);
    cells.push({ engine, channel, textid, mode, median_ms: med, runs: durations.length, verdict: verdictOf(med, mode) });
  }
  return cells;
}
