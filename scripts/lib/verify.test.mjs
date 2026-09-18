// 验证器单测：fixture 全部取自真实工具输出（afinfo/volumedetect 对 zipvoice test_wavs 实跑），
// 判定逻辑与 IO 解耦——check* 为纯函数，assess* 是其 IO 包装（集成面在 S2+ 真实素材上验证）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseAfinfo,
  parseMaxVolumeDb,
  checkRefSpec,
  checkMeta,
  checkBundle,
  REF_MIN_S,
  REF_MAX_S,
} from "./verify.mjs";

// 真实 afinfo 输出（leijun-1.wav：1ch 24000Hz 6.06s——时长不足 10s，本身即负例）
const AFINFO_REAL = `File:           /x/leijun-1.wav
File type ID:   WAVE
Num Tracks:     1
----
Data format:     1 ch,  24000 Hz, Int16
                no channel layout.
estimated duration: 6.056708 sec
audio bytes: 290722
audio packets: 145361
bit rate: 384000 bits per second
`;

const AFINFO_STEREO_44K = `File:           /x/stereo.wav
File type ID:   WAVE
Num Tracks:     1
----
Data format:     2 ch,  44100 Hz, Int16
estimated duration: 15.500000 sec
audio bytes: 27316800
`;

test("parseAfinfo 解析真实输出的声道/采样率/时长", () => {
  assert.deepEqual(parseAfinfo(AFINFO_REAL), { channels: 1, sampleRateHz: 24000, durationS: 6.056708 });
  assert.deepEqual(parseAfinfo(AFINFO_STEREO_44K), { channels: 2, sampleRateHz: 44100, durationS: 15.5 });
});

test("parseAfinfo 对非 afinfo 输出返回 null", () => {
  assert.equal(parseAfinfo("garbage"), null);
  assert.equal(parseAfinfo(""), null);
});

test("parseMaxVolumeDb 解析真实 volumedetect stderr", () => {
  const err = `[Parsed_volumedetect_0 @ 0x13f70af80] mean_volume: -20.9 dB
[Parsed_volumedetect_0 @ 0x13f70af80] max_volume: -2.6 dB`;
  assert.equal(parseMaxVolumeDb(err), -2.6);
  assert.equal(parseMaxVolumeDb("no match here"), null);
});

test("checkRefSpec 通过：15s 单声道 24kHz 峰值 -2.6dB", () => {
  const r = checkRefSpec({ channels: 1, sampleRateHz: 24000, durationS: 15, maxVolumeDb: -2.6 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.reasons, []);
});

test("checkRefSpec 拒绝：时长越界（两侧）/立体声/低采样率/削波", () => {
  const base = { channels: 1, sampleRateHz: 24000, durationS: 15, maxVolumeDb: -2.6 };
  assert.equal(checkRefSpec({ ...base, durationS: REF_MIN_S - 0.01 }).ok, false);
  assert.equal(checkRefSpec({ ...base, durationS: REF_MAX_S + 0.01 }).ok, false);
  assert.equal(checkRefSpec({ ...base, channels: 2 }).ok, false);
  assert.equal(checkRefSpec({ ...base, sampleRateHz: 8000 }).ok, false);
  const clip = checkRefSpec({ ...base, maxVolumeDb: 0.0 });
  assert.equal(clip.ok, false);
  assert.match(clip.reasons.join(), /削波/);
});

test("checkRefSpec 边界含端点：10s 与 30s 恰好通过", () => {
  const base = { channels: 1, sampleRateHz: 24000, maxVolumeDb: -2.6 };
  assert.equal(checkRefSpec({ ...base, durationS: REF_MIN_S }).ok, true);
  assert.equal(checkRefSpec({ ...base, durationS: REF_MAX_S }).ok, true);
});

test("checkRefSpec 缺任一测量值即 FAIL（不猜测）", () => {
  assert.equal(checkRefSpec({ channels: null, sampleRateHz: 24000, durationS: 15, maxVolumeDb: -2.6 }).ok, false);
  assert.equal(checkRefSpec({ channels: 1, sampleRateHz: 24000, durationS: null, maxVolumeDb: null }).ok, false);
});

test("checkMeta 校验八字段齐全", () => {
  const full = {
    character: "dva",
    source_urls: ["https://x"],
    language: "en",
    dub: "en-US",
    license_note: "官方公开素材，本机个人使用，不再分发",
    processing: "raw",
    afinfo: { durationS: 15, sampleRateHz: 24000, channels: 1 },
    collected_at: "2026-09-19T00:00:00Z",
  };
  assert.deepEqual(checkMeta(full), { ok: true, missing: [] });
  const { dub, afinfo, ...rest } = full;
  assert.deepEqual(checkMeta(rest), { ok: false, missing: ["dub", "afinfo"] });
  assert.equal(checkMeta(null).ok, false);
});

test("checkMeta 的 afinfo 空对象不放行（Promise 展开事故回归）", () => {
  const meta = {
    character: "dva", source_urls: ["u"], language: "en", dub: "d",
    license_note: "n", processing: "raw", collected_at: "t",
    afinfo: {},
  };
  const r = checkMeta(meta);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["afinfo.durationS", "afinfo.sampleRateHz", "afinfo.channels"]);
});

test("checkBundle 幂等判据：三件套齐且达标才 complete", () => {
  const good = {
    refExists: true,
    afinfoOut: AFINFO_STEREO_44K.replace("2 ch", "1 ch").replace("15.500000", "15.500000"),
    volumedetectErr: "max_volume: -3.0 dB",
    refTxt: "Hello world",
    metaJson: '{"character":"dva"}',
  };
  // meta 字段不齐 → 不 complete
  assert.equal(checkBundle(good).complete, false);
  // 立体声 → 不 complete
  assert.equal(checkBundle({ ...good, afinfoOut: AFINFO_STEREO_44K }).complete, false);
  // ref.txt 空白 → 不 complete
  assert.equal(checkBundle({ ...good, refTxt: "  \n" }).complete, false);
  // ref.wav 缺失 → 不 complete
  assert.equal(checkBundle({ ...good, refExists: false }).complete, false);
});

test("checkBundle 全达标 → complete 且 reasons 空", () => {
  const meta = JSON.stringify({
    character: "dva",
    source_urls: ["https://x"],
    language: "en",
    dub: "en-US",
    license_note: "n",
    processing: "raw",
    afinfo: { durationS: 15.5, sampleRateHz: 44100, channels: 1 },
    collected_at: "t",
  });
  const r = checkBundle({
    refExists: true,
    afinfoOut: AFINFO_STEREO_44K.replace("2 ch", "1 ch"),
    volumedetectErr: "max_volume: -3.0 dB",
    refTxt: "line",
    metaJson: meta,
  });
  assert.equal(r.complete, true);
  assert.deepEqual(r.reasons, []);
});

// 真实 ffmpeg volumedetect 完整 stderr 尾部（news-female-2.wav 实跑）：
// max_volume 行后跟逐 dB histogram 与输出摘要——旧实现经 500 字符尾窗读取时余量仅约一行，
// 素材动态稍宽即截断；measurePeakDb 改为全量捕获 stderr 后本 fixture 必须可解析。
const VOLUMEDETECT_REAL_FULL = `[Parsed_volumedetect_0 @ 0x148605180] n_samples: 212066
[Parsed_volumedetect_0 @ 0x148605180] mean_volume: -24.3 dB
[Parsed_volumedetect_0 @ 0x148605180] max_volume: -3.8 dB
[Parsed_volumedetect_0 @ 0x148605180] histogram_3db: 2
[Parsed_volumedetect_0 @ 0x148605180] histogram_4db: 15
[Parsed_volumedetect_0 @ 0x148605180] histogram_5db: 50
[Parsed_volumedetect_0 @ 0x148605180] histogram_6db: 125
[Parsed_volumedetect_0 @ 0x148605180] histogram_7db: 191
[out#0/null @ 0x158704980] video:0KiB audio:414KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: unknown
size=N/A time=00:00:08.83 bitrate=N/A speed=2.89e+03x elapsed=0:00:00.00`;

test("parseMaxVolumeDb 解析含 histogram 与摘要尾行的完整真实输出", () => {
  assert.equal(parseMaxVolumeDb(VOLUMEDETECT_REAL_FULL), -3.8);
});

test("measurePeakDb 对真实 wav 返回峰值（全量 stderr，不受尾窗截断）", async () => {
  const { measurePeakDb } = await import("./verify.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "voicemeasure-"));
  const wav = path.join(dir, "tone.wav");
  const { spawnSync } = await import("node:child_process");
  const gen = spawnSync("ffmpeg", ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ar", "24000", "-ac", "1", wav], { encoding: "utf-8" });
  assert.equal(gen.status, 0, gen.stderr);
  const db = measurePeakDb(wav);
  assert.equal(typeof db, "number");
  assert.ok(db != null && db <= 0 && db > -20, `sine 峰值应接近 0dB，实得 ${db}`);
});

test("CLI --only 缺参显式报错 exit 2，不静默退化为全集", async () => {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../fetch-voices.mjs"), "--only"], { encoding: "utf-8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--only 需要角色值/);
  const r2 = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../fetch-voices.mjs"), "--only", "unknown"], { encoding: "utf-8" });
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /未知角色/);
});

test("冒烟判定：>0.5s 为过（与 bench 样本口径一致）", async () => {
  const { assessSmokeDuration } = await import("./verify.mjs");
  assert.equal(assessSmokeDuration(0.51).ok, true);
  assert.equal(assessSmokeDuration(0.5).ok, false);
  assert.equal(assessSmokeDuration(null).ok, false);
});

test("日志行 schema：必备字段齐全且 JSONL 追加", async () => {
  const { appendVoiceLog } = await import("./log.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "voicelog-"));
  const file = path.join(dir, "raw-log.jsonl");
  appendVoiceLog(file, { phase: "download", engine: "voicepack-dva", cmd: "curl x", exit: 0, started: "a", ended: "b", durationMs: 5, outFile: "/tmp/o", outBytes: 10, stderrTail: "" });
  appendVoiceLog(file, { phase: "synth", engine: "voicepack-dva", cmd: "tts x", exit: 0, started: "a", ended: "b", durationMs: 7, outFile: null, outBytes: null, stderrTail: "e" });
  const lines = (await import("node:fs")).readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  for (const l of lines) {
    for (const k of ["ts", "phase", "cmd", "exit", "duration_ms", "out_file", "out_bytes", "stderr_tail"]) {
      assert.ok(k in l, `缺字段 ${k}`);
    }
  }
  assert.equal(lines[0].duration_ms, 5);
  assert.equal(lines[1].stderr_tail, "e");
});
