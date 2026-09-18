// 资产验证器：任务书验收口径的机器判据。
// 解析（parse*）与判定（check*）为纯函数——fixture 可独立复验；assess* 是 IO 包装，
// 与编排者抽查同用 afinfo/ffmpeg 工具口径，杜绝「文件存在即通过」的假绿。
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { runCmd } from "../../bench/lib/exec.mjs";

export const REF_MIN_S = 10;
export const REF_MAX_S = 30;
export const REF_MIN_RATE = 16000;
/** volumedetect max_volume 达数字满刻度即判削波（干音正常峰值远低于 0 dBFS） */
export const CLIP_MAX_DB = -0.01;
/** 冒烟产物下限，与 bench 样本口径一致（>0.5s 为过） */
export const SMOKE_MIN_S = 0.5;

export const META_REQUIRED = ["character", "source_urls", "language", "dub", "license_note", "processing", "afinfo", "collected_at"];

/** @returns {{channels:number, sampleRateHz:number, durationS:number}|null} */
export function parseAfinfo(stdout) {
  const fmt = stdout.match(/Data format:\s*(\d+) ch,\s*(\d+) Hz/);
  const dur = stdout.match(/estimated duration:\s*([\d.]+) sec/);
  if (!fmt || !dur) return null;
  return { channels: Number.parseInt(fmt[1], 10), sampleRateHz: Number.parseInt(fmt[2], 10), durationS: Number.parseFloat(dur[1]) };
}

/** 从 ffmpeg volumedetect stderr 提取峰值 dB；无匹配返回 null（不猜测） */
export function parseMaxVolumeDb(stderr) {
  const m = stderr.match(/max_volume:\s*(-?[\d.]+) dB/);
  return m ? Number.parseFloat(m[1]) : null;
}

/**
 * ref.wav 规格判定：10-30s（含端点）/单声道/≥16kHz/无削波。
 * 任一测量值缺失即 FAIL——缺测量与测量不达标同样不可放行。
 */
export function checkRefSpec({ channels, sampleRateHz, durationS, maxVolumeDb }) {
  const reasons = [];
  if (durationS == null) reasons.push("时长无法测量");
  else if (durationS < REF_MIN_S || durationS > REF_MAX_S) reasons.push(`时长 ${durationS}s 越界（要求 ${REF_MIN_S}-${REF_MAX_S}s）`);
  if (channels == null) reasons.push("声道数无法测量");
  else if (channels !== 1) reasons.push(`声道 ${channels} ≠ 单声道`);
  if (sampleRateHz == null) reasons.push("采样率无法测量");
  else if (sampleRateHz < REF_MIN_RATE) reasons.push(`采样率 ${sampleRateHz}Hz < ${REF_MIN_RATE}Hz`);
  if (maxVolumeDb == null) reasons.push("峰值无法测量");
  else if (maxVolumeDb > CLIP_MAX_DB) reasons.push(`峰值 ${maxVolumeDb}dB 达满刻度，判削波`);
  return { ok: reasons.length === 0, reasons };
}

/** meta.json 字段齐全性（八字段契约见任务书）；afinfo 子字段（时长/采样率/声道）同样必填 */
export function checkMeta(meta) {
  if (meta == null || typeof meta !== "object") return { ok: false, missing: [...META_REQUIRED] };
  const missing = META_REQUIRED.filter((k) => meta[k] == null);
  if (meta.afinfo != null && typeof meta.afinfo === "object") {
    for (const sub of ["durationS", "sampleRateHz", "channels"]) {
      if (meta.afinfo[sub] == null) missing.push(`afinfo.${sub}`);
    }
  }
  return { ok: missing.length === 0, missing };
}

/**
 * 幂等判据（纯函数）：三件套齐且达标 → complete，重跑凭此跳过。
 * 入参为已采集的原始工具输出/文件内容，判定不触 IO。
 */
export function checkBundle({ refExists, afinfoOut, volumedetectErr, refTxt, metaJson }) {
  const reasons = [];
  if (!refExists) reasons.push("ref.wav 不存在");
  const af = afinfoOut != null ? parseAfinfo(afinfoOut) : null;
  const maxDb = volumedetectErr != null ? parseMaxVolumeDb(volumedetectErr) : null;
  const spec = checkRefSpec({ ...(af ?? { channels: null, sampleRateHz: null, durationS: null }), maxVolumeDb: maxDb });
  if (!refExists || !spec.ok) reasons.push(...(spec.ok ? [] : spec.reasons.map((r) => `ref.wav ${r}`)));
  if (refTxt == null || refTxt.trim() === "") reasons.push("ref.txt 缺失或空白");
  let meta = null;
  try {
    meta = metaJson != null ? JSON.parse(metaJson) : null;
  } catch {
    reasons.push("meta.json 不可解析");
  }
  const metaCheck = checkMeta(meta);
  if (!metaCheck.ok) reasons.push(...metaCheck.missing.map((k) => `meta.json 缺字段 ${k}`));
  return { complete: reasons.length === 0, reasons };
}

/** 冒烟产物时长判定：>0.5s 为过（时长不可测 = 不过） */
export function assessSmokeDuration(durationS) {
  if (durationS == null) return { ok: false, reasons: ["时长无法测量"] };
  if (durationS <= SMOKE_MIN_S) return { ok: false, reasons: [`时长 ${durationS}s ≤ ${SMOKE_MIN_S}s`] };
  return { ok: true, reasons: [] };
}

// —— 以下为 IO 包装：真实 afinfo/ffmpeg 执行，供 --verify 与管线复用 ——

/** @returns {Promise<{channels:number,sampleRateHz:number,durationS:number}|null>} */
export async function measureWav(file) {
  const r = await runCmd(["afinfo", file], { timeoutMs: 30_000 });
  return r.exit === 0 ? parseAfinfo(r.stdout) : null;
}

/**
 * 峰值 dB 实测；执行失败返回 null。
 * 不走 bench runCmd——它只保留 stderr 尾 500 字符，而 volumedetect 的 max_volume 行
 * 之后还跟逐 dB histogram 与输出摘要（宽动态素材可超窗），截断会把达标资产误判「峰值无法测量」。
 */
export function measurePeakDb(file) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", "-i", file, "-af", "volumedetect", "-f", "null", "-"], {
    encoding: "utf-8",
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error != null) return null;
  return parseMaxVolumeDb(r.stderr ?? "");
}

/**
 * 单角色资产束实测评估（幂等跳过与 --verify 的共同入口）。
 * @returns {Promise<{complete:boolean, reasons:string[], afinfo:{channels:number,sampleRateHz:number,durationS:number}|null, maxVolumeDb:number|null}>}
 */
export async function assessCharacter(voiceDir) {
  const refWav = `${voiceDir}/ref.wav`;
  const refTxt = `${voiceDir}/ref.txt`;
  const metaFile = `${voiceDir}/meta.json`;
  const refExists = existsSync(refWav);
  let af = null;
  let maxDb = null;
  if (refExists) {
    af = await measureWav(refWav);
    maxDb = measurePeakDb(refWav);
  }
  const bundle = checkBundle({
    refExists,
    afinfoOut: af ? fakeAfinfoText(af) : null,
    volumedetectErr: maxDb != null ? `max_volume: ${maxDb} dB` : null,
    refTxt: existsSync(refTxt) ? readFileSync(refTxt, "utf-8") : null,
    metaJson: existsSync(metaFile) ? readFileSync(metaFile, "utf-8") : null,
  });
  return { ...bundle, afinfo: af, maxVolumeDb: maxDb };
}

// 纯函数 checkBundle 以工具原文为输入；IO 路径已直接拿到解析值，
// 重建最小 afinfo 文本以保持单一判定入口（避免第二套判定逻辑漂移）
function fakeAfinfoText(af) {
  return `Data format:     ${af.channels} ch,  ${af.sampleRateHz} Hz, Int16\nestimated duration: ${af.durationS} sec\n`;
}
