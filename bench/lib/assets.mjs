// 资产 manifest 与幂等落地：每条资产的 URL/通道/字节数在下载时入 raw-log（phase=download），
// 解包与工具安装入 phase=install。后续安装脚本经 report.md 资产清单复用本 manifest。
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { CACHE, MODELS, REPO, SHERPA_VERSION, TOOLS } from "./config.mjs";
import { runCmd } from "./exec.mjs";
import { logLine, nowIso } from "./log.mjs";

const GH = "https://github.com/k2-fsa/sherpa-onnx/releases/download";
const HF_REPO = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit";
const HF_HOSTS = ["https://huggingface.co", "https://hf-mirror.com"];
const HF_DIRECT = `${HF_HOSTS[0]}/${HF_REPO}/resolve/main`;
const HF_MIRROR = `${HF_HOSTS[1]}/${HF_REPO}/resolve/main`;

export const SHERPA_MODELS_DIR = path.join(MODELS, "sherpa");
export const VOCODERS_DIR = path.join(SHERPA_MODELS_DIR, "vocoders");
export const QWEN3_DIR = path.join(MODELS, "mlx-audio", "Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit");

/** 落地后的规范路径（合成执行器与存在性证据共用；解包目录名以实际 tar 结构为准，setup 后校验） */
export const SHERPA_BIN = path.join(TOOLS, `sherpa-onnx-v${SHERPA_VERSION}-osx-arm64-static`, "bin", "sherpa-onnx-offline-tts");
export const KOKORO_DIR = path.join(SHERPA_MODELS_DIR, "kokoro-int8-multi-lang-v1_1");
export const MATCHA_DIR = path.join(SHERPA_MODELS_DIR, "matcha-icefall-zh-baker");
export const ZIPVOICE_DIR = path.join(SHERPA_MODELS_DIR, "sherpa-onnx-zipvoice-distill-int8-zh-en-emilia");
export const VOCOS_22K = path.join(VOCODERS_DIR, "vocos-22khz-univ.onnx");
export const VOCOS_24K = path.join(VOCODERS_DIR, "vocos_24khz.onnx");
export const MLX_TTS_ENTRY = path.join(process.env.HOME ?? "", ".local", "bin", "mlx_audio.tts.generate");

/**
 * @typedef {Object} Asset
 * @property {string} id
 * @property {string} engine raw-log 的 engine 归属
 * @property {string} url
 * @property {"tarbz2"|"file"} kind
 * @property {string} dest 下载落点（tarbz2 为包路径，file 为最终路径）
 * @property {string} marker 就绪标记（存在即跳过下载；tarbz2 为解包后关键文件）
 * @property {string} [extractTo] tarbz2 解包目标目录
 */

/** @type {Asset[]} */
export const SHERPA_ASSETS = [
  {
    id: `sherpa-onnx-v${SHERPA_VERSION}-osx-arm64-static`,
    engine: "sherpa-tooling",
    url: `${GH}/v${SHERPA_VERSION}/sherpa-onnx-v${SHERPA_VERSION}-osx-arm64-static.tar.bz2`,
    kind: "tarbz2",
    dest: path.join(TOOLS, `sherpa-onnx-v${SHERPA_VERSION}-osx-arm64-static.tar.bz2`),
    extractTo: TOOLS,
    marker: SHERPA_BIN,
  },
  {
    // int8 量化是独立发布包（同名 fp32 包为另一资产），跑分口径钉定 int8
    id: "kokoro-int8-multi-lang-v1_1",
    engine: "sherpa-kokoro",
    url: `${GH}/tts-models/kokoro-int8-multi-lang-v1_1.tar.bz2`,
    kind: "tarbz2",
    dest: path.join(SHERPA_MODELS_DIR, "kokoro-int8-multi-lang-v1_1.tar.bz2"),
    extractTo: SHERPA_MODELS_DIR,
    marker: path.join(KOKORO_DIR, "tokens.txt"),
  },
  {
    id: "matcha-icefall-zh-baker",
    engine: "sherpa-matcha",
    url: `${GH}/tts-models/matcha-icefall-zh-baker.tar.bz2`,
    kind: "tarbz2",
    dest: path.join(SHERPA_MODELS_DIR, "matcha-icefall-zh-baker.tar.bz2"),
    extractTo: SHERPA_MODELS_DIR,
    marker: path.join(MATCHA_DIR, "model-steps-3.onnx"),
  },
  {
    id: "vocos-22khz-univ.onnx",
    engine: "sherpa-matcha",
    url: `${GH}/vocoder-models/vocos-22khz-univ.onnx`,
    kind: "file",
    dest: path.join(VOCODERS_DIR, "vocos-22khz-univ.onnx"),
    marker: path.join(VOCODERS_DIR, "vocos-22khz-univ.onnx"),
  },
  {
    id: "sherpa-onnx-zipvoice-distill-int8-zh-en-emilia",
    engine: "sherpa-zipvoice",
    url: `${GH}/tts-models/sherpa-onnx-zipvoice-distill-int8-zh-en-emilia.tar.bz2`,
    kind: "tarbz2",
    dest: path.join(SHERPA_MODELS_DIR, "sherpa-onnx-zipvoice-distill-int8-zh-en-emilia.tar.bz2"),
    extractTo: SHERPA_MODELS_DIR,
    marker: path.join(ZIPVOICE_DIR, "tokens.txt"),
  },
  {
    id: "vocos_24khz.onnx",
    engine: "sherpa-zipvoice",
    url: `${GH}/vocoder-models/vocos_24khz.onnx`,
    kind: "file",
    dest: path.join(VOCODERS_DIR, "vocos_24khz.onnx"),
    marker: path.join(VOCODERS_DIR, "vocos_24khz.onnx"),
  },
];

/**
 * curl 下载并落 raw-log；HF 资产失败时换镜像通道重试一次。
 * -f 必带：无它时 HTTP 4xx/5xx 的错误页会被 -o 落盘且 exit 0，字节阈值挡不住错误页体积，
 * 假成功行会污染证据链且 marker 使重跑永久 skip。
 * expectedBytes 传入时以精确字节数判成败（HF API size）；否则 tar.bz2 用 >1KB、普通文件 >0——
 * 统一字节阈值会把 HF 的百字节 config 误判为失败触发无谓重试。
 */
async function downloadAsset(asset, expectedBytes = null) {
  if (expectedBytes == null && existsSync(asset.marker)) return { ok: true, skipped: true };
  mkdirSync(path.dirname(asset.dest), { recursive: true });
  const channels = asset.url.startsWith(HF_HOSTS[0])
    ? [
        { net: "direct", url: asset.url },
        { net: "mirror", url: asset.url.replace(HF_DIRECT, HF_MIRROR) },
      ]
    : [{ net: "direct", url: asset.url }];
  let last = null;
  for (const ch of channels) {
    const cmd = ["curl", "-s", "-f", "-L", "-C", "-", "--retry", "2", "--connect-timeout", "15", "-o", asset.dest, ch.url];
    const r = await runCmd(cmd, { timeoutMs: 45 * 60 * 1000 });
    const bytes = existsSync(asset.dest) ? statSync(asset.dest).size : 0;
    logLine({
      ts: nowIso(), phase: "download", engine: asset.engine, channel: null,
      model: asset.id, textid: null, run: null, mode: null,
      cmd: r.cmdStr, exit: r.exit, started: r.started, ended: r.ended,
      duration_ms: r.durationMs, out_file: asset.dest, out_bytes: bytes,
      stderr_tail: r.stderrTail, net_channel: ch.net, url: ch.url,
    });
    const sizeOk = expectedBytes != null ? bytes === expectedBytes : asset.kind === "tarbz2" ? bytes > 1024 : bytes > 0;
    if (r.exit === 0 && sizeOk) return { ok: true, skipped: false, bytes };
    last = { exit: r.exit, bytes, stderr: r.stderrTail };
  }
  return { ok: false, ...last };
}

async function extractTar(asset) {
  if (existsSync(asset.marker)) return { ok: true, skipped: true };
  mkdirSync(asset.extractTo, { recursive: true });
  const cmd = ["tar", "xjf", asset.dest, "-C", asset.extractTo];
  const r = await runCmd(cmd, { timeoutMs: 10 * 60 * 1000 });
  logLine({
    ts: nowIso(), phase: "install", engine: asset.engine, channel: null,
    model: asset.id, textid: null, run: null, mode: null,
    cmd: r.cmdStr, exit: r.exit, started: r.started, ended: r.ended,
    duration_ms: r.durationMs, out_file: asset.extractTo, out_bytes: null,
    stderr_tail: r.stderrTail,
  });
  return { ok: r.exit === 0 && existsSync(asset.marker), exit: r.exit };
}

/** HF 仓库文件清单（?blobs=true 带字节数）；直连与镜像依次尝试——清单一步断裂会拖垮整组资产 */
async function hfFileList() {
  for (const host of HF_HOSTS) {
    const cmd = ["curl", "-s", "-f", "-L", "--connect-timeout", "15", `${host}/api/models/${HF_REPO}?blobs=true`];
    const r = await runCmd(cmd, { timeoutMs: 60_000 });
    if (r.exit !== 0) continue;
    try {
      const meta = JSON.parse(r.stdout);
      const list = (meta.siblings ?? [])
        .filter((s) => s.size != null && s.size > 0)
        .map((s) => ({ file: s.rfilename, size: s.size }));
      if (list.length > 0) return list;
    } catch {
      // 响应非 JSON（错误页/限流）即换下一通道
    }
  }
  return null;
}

async function ensureQwen3(failures) {
  const list = await hfFileList();
  if (!list) {
    failures.push({ id: HF_REPO, reason: "HF API 文件清单获取失败（direct 与 mirror 均不可用）", tried: "direct,mirror" });
    return;
  }
  for (const { file, size } of list) {
    const dest = path.join(QWEN3_DIR, file);
    if (existsSync(dest) && statSync(dest).size === size) continue;
    mkdirSync(path.dirname(dest), { recursive: true });
    const asset = { id: `${HF_REPO}/${file}`, engine: "mlx-qwen3", url: `${HF_DIRECT}/${file}`, kind: "file", dest, marker: dest };
    const r = await downloadAsset(asset, size);
    if (!r.ok || !existsSync(dest) || statSync(dest).size !== size) {
      failures.push({ id: asset.id, reason: r.stderr || `下载失败或字节数不符（期望 ${size}，实际 ${existsSync(dest) ? statSync(dest).size : 0}）`, tried: "direct,mirror" });
    }
  }
}

async function ensureMlxAudio(failures) {
  const listed = await runCmd(["uv", "tool", "list"], { timeoutMs: 60_000 });
  if (listed.exit === 0 && /mlx-audio/.test(listed.stdout)) return;
  const cmd = ["uv", "tool", "install", "mlx-audio"];
  const r = await runCmd(cmd, { timeoutMs: 20 * 60 * 1000 });
  logLine({
    ts: nowIso(), phase: "install", engine: "mlx-audio", channel: null,
    model: "mlx-audio", textid: null, run: null, mode: null,
    cmd: r.cmdStr, exit: r.exit, started: r.started, ended: r.ended,
    duration_ms: r.durationMs, out_file: null, out_bytes: null, stderr_tail: r.stderrTail,
  });
  if (r.exit !== 0) failures.push({ id: "mlx-audio", reason: r.stderrTail || `exit ${r.exit}`, tried: "uv tool install" });
}

async function ensureSherpaNode(failures) {
  const marker = path.join(REPO, "node_modules", "sherpa-onnx-node");
  if (existsSync(marker)) return;
  const cmd = ["pnpm", "add", "-D", "sherpa-onnx-node"];
  const r = await runCmd(cmd, { cwd: REPO, timeoutMs: 10 * 60 * 1000 });
  logLine({
    ts: nowIso(), phase: "install", engine: "npm", channel: null,
    model: "sherpa-onnx-node", textid: null, run: null, mode: null,
    cmd: r.cmdStr, exit: r.exit, started: r.started, ended: r.ended,
    duration_ms: r.durationMs, out_file: path.join(REPO, "package.json"), out_bytes: null,
    stderr_tail: r.stderrTail,
  });
  if (r.exit !== 0 || !existsSync(marker)) {
    failures.push({ id: "sherpa-onnx-node", reason: r.stderrTail || `exit ${r.exit}`, tried: "pnpm add -D" });
  }
}

/**
 * 幂等落地全部资产；失败项进 failures（做不出的资产记原因与已试通道，不虚构成功）。
 * @returns {Promise<{ok: boolean, failures: Array<{id: string, reason: string, tried: string}>}>}
 */
export async function ensureAssets() {
  mkdirSync(CACHE, { recursive: true });
  /** @type {Array<{id: string, reason: string, tried: string}>} */
  const failures = [];
  for (const asset of SHERPA_ASSETS) {
    const d = await downloadAsset(asset);
    if (asset.kind === "tarbz2") {
      if (existsSync(asset.marker)) continue;
      // 包在盘即尝试解包：下载步骤失败（如对完整包续传触发 416）但旧包完好时可自愈
      if (existsSync(asset.dest)) {
        const e = await extractTar(asset);
        if (e.ok) continue;
        failures.push({ id: asset.id, reason: `解包失败 exit ${e.exit}`, tried: "tar xjf" });
        continue;
      }
      failures.push({ id: asset.id, reason: d.stderr || `下载失败 exit ${d.exit}`, tried: "direct" });
      continue;
    }
    if (!d.ok) failures.push({ id: asset.id, reason: d.stderr || `下载失败 exit ${d.exit}`, tried: "direct" });
  }
  await ensureMlxAudio(failures);
  await ensureQwen3(failures);
  await ensureSherpaNode(failures);
  return { ok: failures.length === 0, failures };
}
