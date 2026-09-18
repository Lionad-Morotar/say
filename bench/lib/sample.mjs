// 样本转制与有效性判定：verify 的「真实出声」证据面。
// 44 字节空 wav 判通过的失败模式由此封堵：数据字节从 RIFF data 块精确解析，不信任文件存在性。
import { readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { MIN_SAMPLE_DATA_BYTES, MIN_SAMPLE_DURATION_S, SAMPLES, SAMPLE_RATE } from "./config.mjs";
import { runCmd } from "./exec.mjs";

/** 原始输出 → 试听样本（22050Hz 16bit 单声道）：verify 与独立抽查的统一口径 */
export async function convertToSample(rawPath, engine, channel, textid) {
  const dest = path.join(SAMPLES, `${engine}-${channel}-${textid}.wav`);
  const r = await runCmd(["afconvert", "-f", "WAVE", "-d", `LEI16@${SAMPLE_RATE}`, "-c", "1", rawPath, dest], { timeoutMs: 60_000 });
  return { ok: r.exit === 0 && existsSync(dest), dest, stderrTail: r.stderrTail };
}

/**
 * 解析 wav 的 data 块字节数（精确值，非文件大小近似）。
 * 44 字节空 wav 的 data 块为 0 —— 空文件被判「正常」的失败模式在此必须 FAIL。
 * @returns {number|null} 非 wav 或无 data 块返回 null
 */
export function wavDataBytes(file) {
  if (!existsSync(file)) return null;
  const buf = readFileSync(file);
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") return size;
    off += 8 + size + (size % 2);
  }
  return null;
}

/** afinfo 的 estimated duration（秒）；编排者独立抽查用同一工具，口径一致 */
export async function afinfoDurationS(file) {
  const r = await runCmd(["afinfo", file], { timeoutMs: 30_000 });
  const m = r.stdout.match(/estimated duration:\s*([\d.]+)\s*sec/);
  return m ? Number.parseFloat(m[1]) : null;
}

/**
 * 单样本有效性判定：数据字节 + afinfo 时长双检，任一不过即无效。
 * @returns {Promise<{ok: boolean, dataBytes: number|null, durationS: number|null, reasons: string[]}>}
 */
export async function checkSample(file) {
  const reasons = [];
  if (!existsSync(file)) return { ok: false, dataBytes: null, durationS: null, reasons: ["文件不存在"] };
  const fileSize = statSync(file).size;
  const dataBytes = wavDataBytes(file);
  if (dataBytes == null) reasons.push("无法解析 RIFF data 块（非有效 wav）");
  else if (dataBytes < MIN_SAMPLE_DATA_BYTES) reasons.push(`数据字节 ${dataBytes} < ${MIN_SAMPLE_DATA_BYTES}（0.5s 下限）——空/超短样本`);
  const durationS = await afinfoDurationS(file);
  if (durationS == null) reasons.push("afinfo 无法读取时长");
  else if (durationS <= MIN_SAMPLE_DURATION_S) reasons.push(`时长 ${durationS}s ≤ ${MIN_SAMPLE_DURATION_S}s`);
  if (reasons.length === 0 && fileSize < MIN_SAMPLE_DATA_BYTES) reasons.push(`文件大小 ${fileSize}B 异常`);
  return { ok: reasons.length === 0, dataBytes, durationS, reasons };
}
