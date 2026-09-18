// 采集管线：下载 → 截取/转制 →（可选人声分离）→ 转写 → meta → 验证 → 冒烟。
// 每角色按 manifest 候选序 fail-fast；每个真实执行（下载/处理/转写/合成/安装）落 raw-log，
// 幂等 skip 只报 stdout 不入日志。素材与产物只落 VOICES_DIR / VOICEPACK_DOCS，均不入 git。
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs";
import path from "node:path";
import { runCmd } from "../../bench/lib/exec.mjs";
import { appendVoiceLog } from "./log.mjs";
import { RAW_LOG, VOICES_DIR, VOICEPACK_DOCS, WORK_DIR, SHERPA_TTS_BIN, ZIPVOICE_DIR, VOCODER_24K } from "./config.mjs";
import { MANIFEST } from "./manifest.mjs";
import { assessCharacter, assessSmokeDuration, measureWav, measurePeakDb } from "./verify.mjs";

/** 冒烟合成文本（平静陈述句，只验真实合成与有效音频，角色相似度归 s-voice 试听终裁） */
export const SMOKE_TEXT = "Hey, this is a smoke test line for the character voice pack.";

/** 分离前粗截的外扩秒数：demucs 需要上下文窗口，贴边截会引入边界伪影 */
export const SEP_PAD_S = 5;

// —— 纯函数（单测覆盖）——

/** ref.txt 约定：正文为逐字转写，# 起始行为溯源注释；合成前剥离注释 */
export function stripRefComments(txt) {
  return txt
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** ffmpeg 截取+转制参数：单声道 24kHz 16bit（对齐 zipvoice 官方 reference 规格） */
export function buildCutArgs({ src, dest, cut }) {
  const args = ["-hide_banner", "-nostdin", "-y"];
  if (cut) args.push("-ss", String(cut.startS), "-to", String(cut.endS));
  args.push("-i", src, "-vn", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", dest);
  return args;
}

/** zipvoice 冒烟命令：形态锚定 s-bench raw-log 已验证行（同 binary/flag/步数） */
export function buildSmokeCmd({ refWav, refText, text, outFile, bin = SHERPA_TTS_BIN, modelDir = ZIPVOICE_DIR, vocoder = VOCODER_24K }) {
  return [
    bin,
    `--zipvoice-encoder=${path.join(modelDir, "encoder.int8.onnx")}`,
    `--zipvoice-decoder=${path.join(modelDir, "decoder.int8.onnx")}`,
    `--zipvoice-data-dir=${path.join(modelDir, "espeak-ng-data")}`,
    `--zipvoice-lexicon=${path.join(modelDir, "lexicon.txt")}`,
    `--zipvoice-tokens=${path.join(modelDir, "tokens.txt")}`,
    `--zipvoice-vocoder=${vocoder}`,
    `--reference-audio=${refWav}`,
    `--reference-text=${refText}`,
    "--num-steps=4",
    "--num-threads=2",
    `--output-filename=${outFile}`,
    text,
  ];
}

/** 粗截窗外扩（钳 0）+ 分离产物内的精截偏移 */
export function buildRoughCut(cut) {
  const roughStart = Math.max(0, cut.startS - SEP_PAD_S);
  return {
    rough: { startS: roughStart, endS: cut.endS + SEP_PAD_S },
    innerStartS: cut.startS - roughStart,
    innerEndS: cut.startS - roughStart + (cut.endS - cut.startS),
  };
}

export function buildSeparateArgs({ src, outDir }) {
  return ["-n", "htdemucs", "--two-stems=vocals", "-o", outDir, src];
}

export function buildMeta({ character, cand, afinfo, peakDb, collectedAt }) {
  const processing = cand.separate
    ? `separated:${cand.separate.tool}@${cand.separate.version}:${cand.separate.args}`
    : "raw";
  return {
    character,
    source_urls: [cand.url, cand.pageUrl].filter(Boolean),
    language: cand.language,
    dub: cand.dub,
    license_note: "官方公开素材，本机个人使用，不再分发",
    processing,
    afinfo: { ...afinfo, peakDb },
    collected_at: collectedAt,
    transcription: { source: cand.textSource ?? null, ...(cand.transcribe ?? {}) },
  };
}

// —— IO 执行（全部落 raw-log）——

async function logged(phase, engine, cmd, opts = {}) {
  const r = await runCmd(cmd, { timeoutMs: opts.timeoutMs ?? 600_000 });
  // findOutFile：产物路径执行后才可知（如 yt-dlp %(ext)s）时的回填钩子，schema 组装保持单点
  const outFile = opts.outFile ?? (opts.findOutFile ? opts.findOutFile() : null) ?? null;
  const outBytes = outFile && existsSync(outFile) ? statSync(outFile).size : null;
  appendVoiceLog(RAW_LOG, {
    phase,
    engine,
    cmd: r.cmdStr,
    exit: r.exit,
    started: r.started,
    ended: r.ended,
    durationMs: r.durationMs,
    outFile,
    outBytes,
    stderrTail: r.stderrTail,
    ...(opts.url ? { url: opts.url } : {}),
  });
  return r;
}

/** yt-dlp bestaudio 实际可落盘的扩展名（m4a/opus 在部分 client 组合下出现，漏收会把 exit 0 误判失败） */
const YT_EXTS = ["webm", "mka", "mp4", "m4a", "opus", "ogg"];
const findYtFile = (dest) => YT_EXTS.map((e) => `${dest}.${e}`).find((f) => existsSync(f) && statSync(f).size > 1_000_000);

/**
 * 下载源素材。ytdlp 走 player_client 降级链：本机实测默认 client 对部分视频 403、
 * web_embedded 可过；代理仅在直连失败时启用（与 bench 的 direct→mirror 双通道同思路）。
 */
export async function downloadSource(character, cand) {
  mkdirSync(WORK_DIR, { recursive: true });
  const dest = path.join(WORK_DIR, `${character}-${cand.id}`);
  const engine = `voicepack-${character}`;
  if (cand.kind === "direct") {
    const ext = path.extname(new URL(cand.url).pathname) || ".bin";
    const out = dest + ext;
    if (existsSync(out) && statSync(out).size > 0) {
      console.log(`[skip] 源素材已在盘: ${out}`);
      return out;
    }
    const r = await logged("download", engine, ["curl", "-fL", "--retry", "2", "--connect-timeout", "15", "-o", out, cand.url], { outFile: out, url: cand.url });
    return r.exit === 0 && existsSync(out) ? out : null;
  }
  if (cand.kind === "ytdlp") {
    const existing = findYtFile(dest);
    if (existing) {
      console.log(`[skip] 源素材已在盘: ${existing}`);
      return existing;
    }
    const clients = ["web_embedded", "default"];
    for (const client of clients) {
      for (const proxy of [null, "http://127.0.0.1:7897"]) {
        const cmd = [
          "yt-dlp", "--no-warnings", "--no-playlist",
          ...(client === "default" ? [] : ["--extractor-args", `youtube:player_client=${client}`]),
          ...(proxy ? ["--proxy", proxy] : []),
          "-f", "ba", "-o", `${dest}.%(ext)s`, cand.url,
        ];
        // yt-dlp 的 %(ext)s 落盘后才知道真实文件名，经 findOutFile 回填 out_file/out_bytes
        const r = await logged("download", engine, cmd, { url: cand.url, timeoutMs: 1_800_000, findOutFile: () => findYtFile(dest) });
        const got = findYtFile(dest);
        if (r.exit === 0 && got) return got;
        console.log(`[retry] yt-dlp client=${client} proxy=${proxy ?? "direct"} 失败（exit=${r.exit}）`);
      }
    }
    return null;
  }
  throw new Error(`未知候选 kind: ${cand.kind}`);
}

/** 截取+转制为 ref.wav；分离素材走「粗截→demucs 人声茎→精截」三步，各步落 raw-log */
export async function processSegment(character, cand, srcFile, voiceDir) {
  mkdirSync(voiceDir, { recursive: true });
  const engine = `voicepack-${character}`;
  const dest = path.join(voiceDir, "ref.wav");
  if (!cand.separate) {
    const args = buildCutArgs({ src: srcFile, dest, cut: cand.cut ?? null });
    const r = await logged("process", engine, ["ffmpeg", ...args], { outFile: dest });
    return r.exit === 0 && existsSync(dest);
  }
  if (!cand.cut) throw new Error(`separate 候选必须携带 cut（${character}/${cand.id}）`);
  const { rough, innerStartS, innerEndS } = buildRoughCut(cand.cut);
  // 中间产物文件名携带截取窗参数：manifest 改窗口后旧缓存自动失效，
  // 否则按旧窗起点算出的内层偏移会静默错位
  const roughFile = path.join(WORK_DIR, `${character}-${cand.id}-rough-${cand.cut.startS}-${cand.cut.endS}.wav`);
  if (existsSync(roughFile) && statSync(roughFile).size > 0) {
    console.log(`[skip] 粗截已在盘: ${roughFile}`);
  } else {
    const r1 = await logged("process", engine, ["ffmpeg", ...buildCutArgs({ src: srcFile, dest: roughFile, cut: rough })], { outFile: roughFile });
    if (r1.exit !== 0 || !existsSync(roughFile)) return false;
  }
  const sepDir = path.join(WORK_DIR, "separated");
  const vocalsFile = path.join(sepDir, "htdemucs", path.basename(roughFile, ".wav"), "vocals.wav");
  if (existsSync(vocalsFile) && statSync(vocalsFile).size > 0) {
    console.log(`[skip] 分离产物已在盘: ${vocalsFile}`);
  } else {
    // demucs 首跑自下载 htdemucs 权重（~80MB），下载痕迹体现在本行 stderr
    const r2 = await logged("process", engine, ["demucs", ...buildSeparateArgs({ src: roughFile, outDir: sepDir })], { outFile: vocalsFile, timeoutMs: 1_200_000 });
    if (r2.exit !== 0 || !existsSync(vocalsFile)) return false;
  }
  const r3 = await logged("process", engine, ["ffmpeg", ...buildCutArgs({ src: vocalsFile, dest, cut: { startS: innerStartS, endS: innerEndS } })], { outFile: dest });
  return r3.exit === 0 && existsSync(dest);
}

/** whisper 转写（无官方文本的素材）；模型下载由 whisper 自管，转写执行落 raw-log */
export async function transcribeWithWhisper(character, refWav, voiceDir, transcribeSpec) {
  const outDir = path.join(voiceDir, ".whisper-tmp");
  mkdirSync(outDir, { recursive: true });
  const cmd = [
    "whisper", refWav,
    "--model", transcribeSpec.model,
    "--language", transcribeSpec.language,
    "--output_format", "txt",
    "--output_dir", outDir,
    "--fp16", "False",
    // 无提示时 turbo 倾向输出全小写无标点平文本；ref.txt 作为 reference-text
    // 与人工核对材料，规范大小写标点更利对账（不影响音素内容）
    "--initial_prompt", transcribeSpec.initialPrompt ?? "Transcribe verbatim with standard capitalization and punctuation.",
  ];
  const r = await logged("transcribe", `voicepack-${character}`, cmd, { timeoutMs: 1_200_000, outFile: path.join(outDir, `${path.basename(refWav, ".wav")}.txt`) });
  const txtFile = path.join(outDir, `${path.basename(refWav, ".wav")}.txt`);
  if (r.exit !== 0 || !existsSync(txtFile)) return null;
  const text = readFileSync(txtFile, "utf-8").trim();
  rmSync(outDir, { recursive: true, force: true });
  return text;
}

/** ref.txt 落盘：正文逐字转写 + 溯源注释（合成时剥离） */
export function writeRefTxt(voiceDir, text, sourceNote) {
  writeFileSync(path.join(voiceDir, "ref.txt"), `${text}\n\n# 转写来源: ${sourceNote}\n`, "utf-8");
}

/** 冒烟合成：复用 s-bench 已验证命令形态；产物落 VOICEPACK_DOCS */
export async function smokeSynth(character, voiceDir) {
  const refWav = path.join(voiceDir, "ref.wav");
  const refTxtFile = path.join(voiceDir, "ref.txt");
  const outFile = path.join(VOICEPACK_DOCS, `smoke-${character}.wav`);
  const existing = existsSync(outFile) ? await measureWav(outFile) : null;
  if (existing && assessSmokeDuration(existing.durationS).ok) {
    console.log(`[skip] 冒烟产物已达标: ${outFile}（${existing.durationS}s）`);
    return true;
  }
  const refText = stripRefComments(readFileSync(refTxtFile, "utf-8"));
  const cmd = buildSmokeCmd({ refWav, refText, text: SMOKE_TEXT, outFile });
  const r = await logged("synth", `voicepack-${character}`, cmd, { outFile, timeoutMs: 900_000 });
  if (r.exit !== 0 || !existsSync(outFile)) return false;
  const af = await measureWav(outFile);
  const ok = af != null && assessSmokeDuration(af.durationS).ok;
  console.log(`[smoke] ${character}: exit=${r.exit} 时长=${af?.durationS ?? "N/A"}s → ${ok ? "PASS" : "FAIL"}`);
  return ok;
}

/** 单角色采集：幂等跳过 → 候选序 fail-fast → 达标即冒烟 */
export async function runCharacter(character) {
  const voiceDir = path.join(VOICES_DIR, character);
  const entry = MANIFEST[character];
  const before = await assessCharacter(voiceDir);
  const smokeFile = path.join(VOICEPACK_DOCS, `smoke-${character}.wav`);
  const smokeBefore = existsSync(smokeFile) ? assessSmokeDuration((await measureWav(smokeFile))?.durationS ?? null).ok : false;
  if (before.complete && smokeBefore) {
    console.log(`[skip] ${character} 资产与冒烟均已达标，跳过`);
    return true;
  }
  if (entry.candidates.length === 0) {
    console.error(`[degraded] ${character}: manifest 无素材候选`);
    return false;
  }
  for (const cand of entry.candidates) {
    console.log(`[candidate] ${character}/${cand.id}: ${cand.url}`);
    const src = await downloadSource(character, cand);
    if (!src) {
      console.error(`[fail] ${character}/${cand.id}: 下载失败（详见 raw-log）`);
      continue;
    }
    const processed = await processSegment(character, cand, src, voiceDir);
    if (!processed) {
      console.error(`[fail] ${character}/${cand.id}: 截取转制失败（详见 raw-log）`);
      continue;
    }
    // 文本：官方台词优先，whisper 兜底
    if (cand.text) {
      writeRefTxt(voiceDir, cand.text, cand.textSource);
    } else if (cand.transcribe) {
      const text = await transcribeWithWhisper(character, path.join(voiceDir, "ref.wav"), voiceDir, cand.transcribe);
      if (!text) {
        console.error(`[fail] ${character}/${cand.id}: whisper 转写失败（详见 raw-log）`);
        continue;
      }
      writeRefTxt(voiceDir, text, cand.textSource ?? `whisper 转写（openai-whisper 20250625，模型 ${cand.transcribe.model}）`);
    } else {
      console.error(`[fail] ${character}/${cand.id}: 候选既无官方文本也无转写方案`);
      continue;
    }
    const af = await measureWav(path.join(voiceDir, "ref.wav"));
    const peakDb = measurePeakDb(path.join(voiceDir, "ref.wav"));
    writeFileSync(
      path.join(voiceDir, "meta.json"),
      JSON.stringify(buildMeta({ character, cand, afinfo: af ?? { durationS: null, sampleRateHz: null, channels: null }, peakDb, collectedAt: new Date().toISOString() }), null, 2) + "\n",
      "utf-8",
    );
    const after = await assessCharacter(voiceDir);
    if (!after.complete) {
      console.error(`[fail] ${character}/${cand.id}: 资产不达标 → ${after.reasons.join("; ")}`);
      continue;
    }
    const smoked = await smokeSynth(character, voiceDir);
    if (!smoked) {
      console.error(`[fail] ${character}/${cand.id}: 冒烟合成失败（详见 raw-log）`);
      continue;
    }
    console.log(`[done] ${character}: 资产与冒烟全部达标（候选 ${cand.id}）`);
    return true;
  }
  console.error(`[degraded] ${character}: 全部候选失败，原因见 raw-log`);
  return false;
}

export async function runPipeline(targets) {
  mkdirSync(VOICEPACK_DOCS, { recursive: true });
  const results = {};
  for (const c of targets) results[c] = await runCharacter(c);
  console.log(JSON.stringify(results, null, 2));
  process.exit(Object.values(results).every(Boolean) ? 0 : 1);
}
