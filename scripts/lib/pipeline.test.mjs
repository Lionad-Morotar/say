// 管线纯函数单测：命令构造与 meta 组装可在无网络/无素材环境下验证；
// 期望值锚定 s-bench raw-log 中已验证的 zipvoice 命令形态（独立事实源）。
import test from "node:test";
import assert from "node:assert/strict";
import { stripRefComments, buildCutArgs, buildSmokeCmd, buildMeta, buildRoughCut, buildSeparateArgs, SEP_PAD_S } from "./pipeline.mjs";

test("buildRoughCut 外扩截取窗并给出内层偏移，起点钳到 0", () => {
  assert.deepEqual(buildRoughCut({ startS: 90.5, endS: 119.5 }), { rough: { startS: 90.5 - SEP_PAD_S, endS: 119.5 + SEP_PAD_S }, innerStartS: SEP_PAD_S, innerEndS: SEP_PAD_S + 29 });
  assert.deepEqual(buildRoughCut({ startS: 2, endS: 20 }).rough.startS, 0);
  assert.equal(buildRoughCut({ startS: 2, endS: 20 }).innerStartS, 2);
});

test("buildSeparateArgs 生成 htdemucs 双茎人声分离参数", () => {
  const args = buildSeparateArgs({ src: "/w/rough.wav", outDir: "/w/sep" });
  assert.deepEqual(args, ["-n", "htdemucs", "--two-stems=vocals", "-o", "/w/sep", "/w/rough.wav"]);
});

test("stripRefComments 剥离 # 注释行并合并文本行", () => {
  assert.equal(stripRefComments("Hello!\n# 转写来源: wiki\n"), "Hello!");
  assert.equal(stripRefComments("# only comment\n"), "");
  assert.equal(stripRefComments("line1\nline2\n# c"), "line1 line2");
});

test("buildCutArgs 生成截取+单声道+24kHz 16bit 转制参数", () => {
  const args = buildCutArgs({ src: "/w/src.webm", dest: "/v/ref.wav", cut: { startS: 60.5, endS: 85 } });
  assert.deepEqual(args.slice(0, 2), ["-hide_banner", "-nostdin"]);
  const ss = args.indexOf("-ss");
  assert.equal(args[ss + 1], "60.5");
  const to = args.indexOf("-to");
  assert.equal(args[to + 1], "85");
  assert.ok(args.includes("-ac") && args[args.indexOf("-ac") + 1] === "1");
  assert.ok(args.includes("-ar") && args[args.indexOf("-ar") + 1] === "24000");
  assert.ok(args.includes("pcm_s16le"));
  assert.equal(args[args.length - 1], "/v/ref.wav");
});

test("buildCutArgs 无 cut 时整段转制", () => {
  const args = buildCutArgs({ src: "/w/s.mp3", dest: "/v/ref.wav", cut: null });
  assert.ok(!args.includes("-ss") && !args.includes("-to"));
});

test("buildSmokeCmd 复刻 s-bench 已验证的 zipvoice 命令形态", () => {
  const cmd = buildSmokeCmd({
    refWav: "/v/dva/ref.wav",
    refText: "Nerf this!",
    text: "Smoke test line.",
    outFile: "/d/smoke-dva.wav",
    bin: "/t/sherpa-onnx-offline-tts",
    modelDir: "/m/zipvoice",
    vocoder: "/m/vocos_24khz.onnx",
  });
  assert.equal(cmd[0], "/t/sherpa-onnx-offline-tts");
  assert.ok(cmd.includes("--zipvoice-encoder=/m/zipvoice/encoder.int8.onnx"));
  assert.ok(cmd.includes("--zipvoice-decoder=/m/zipvoice/decoder.int8.onnx"));
  assert.ok(cmd.includes("--zipvoice-data-dir=/m/zipvoice/espeak-ng-data"));
  assert.ok(cmd.includes("--zipvoice-lexicon=/m/zipvoice/lexicon.txt"));
  assert.ok(cmd.includes("--zipvoice-tokens=/m/zipvoice/tokens.txt"));
  assert.ok(cmd.includes("--zipvoice-vocoder=/m/vocos_24khz.onnx"));
  assert.ok(cmd.includes("--reference-audio=/v/dva/ref.wav"));
  assert.ok(cmd.includes("--reference-text=Nerf this!"));
  assert.ok(cmd.includes("--num-steps=4") && cmd.includes("--num-threads=2"));
  assert.ok(cmd.includes("--output-filename=/d/smoke-dva.wav"));
  assert.equal(cmd[cmd.length - 1], "Smoke test line.");
});

test("buildMeta 八字段齐全并携带转写溯源", () => {
  const cand = {
    id: "ow2-clips",
    kind: "ytdlp",
    url: "https://youtube.com/watch?v=X",
    pageUrl: "https://overwatch.fandom.com/wiki/D.Va/Quotes",
    language: "en",
    dub: "en-US（Charlet Chung）",
    textSource: "overwatch wiki D.Va/Quotes 官方台词文本",
  };
  const meta = buildMeta({ character: "dva", cand, afinfo: { durationS: 24.5, sampleRateHz: 24000, channels: 1 }, peakDb: -1.2, collectedAt: "2026-09-19T00:00:00.000Z" });
  assert.equal(meta.character, "dva");
  assert.deepEqual(meta.source_urls, [cand.url, cand.pageUrl]);
  assert.equal(meta.language, "en");
  assert.equal(meta.dub, cand.dub);
  assert.equal(meta.license_note, "官方公开素材，本机个人使用，不再分发");
  assert.equal(meta.processing, "raw");
  assert.deepEqual(meta.afinfo, { durationS: 24.5, sampleRateHz: 24000, channels: 1, peakDb: -1.2 });
  assert.equal(meta.collected_at, "2026-09-19T00:00:00.000Z");
  assert.equal(meta.transcription.source, cand.textSource);
});

test("buildMeta 分离素材 processing 记工具与参数摘要", () => {
  const cand = { id: "x", kind: "ytdlp", url: "u", language: "en", dub: "en", separate: { tool: "demucs", version: "4.0.1", args: "htdemucs --two-stems=vocals" } };
  const meta = buildMeta({ character: "lucy", cand, afinfo: { durationS: 20, sampleRateHz: 24000, channels: 1 }, peakDb: -3, collectedAt: "t" });
  assert.equal(meta.processing, "separated:demucs@4.0.1:htdemucs --two-stems=vocals");
});
