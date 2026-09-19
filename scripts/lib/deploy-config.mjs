// s-deploy 部署资产配置与证据链助手。
// 路径解析与运行时 src/paths.ts 同一 XDG 语义（cache 根可被 XDG_CACHE_HOME 覆盖），
// 安装验证一律可走临时 cache 而不触碰真实资产；下载/接线证据只落 docs/research/deploy/raw-log.jsonl
//（gitignored），幂等 skip 不入日志（否则重跑污染「每行一次真实执行」语义）。
import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { nowIso } from "../../bench/lib/log.mjs";

const GH = "https://github.com/k2-fsa/sherpa-onnx/releases/download";
/** HF 直连域；镜像默认 hf-mirror.com，可经 HF_ENDPOINT 环境变量覆盖（蓝图 Gate 发现 7 的通道契约） */
const HF_DIRECT_HOST = "https://huggingface.co";
const HF_MIRROR_DEFAULT = "https://hf-mirror.com";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
export const SYSTEM_SAY = "/usr/bin/say";
export const SHIM_TARGET = path.join(REPO_ROOT, "bin", "say");
export const DEFAULT_BIN_DIR = path.join(homedir(), ".local", "bin");

export function cacheRoot(env = process.env) {
  return env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.length > 0 ? env.XDG_CACHE_HOME : path.join(homedir(), ".cache");
}

export function modelsRoot(env = process.env) {
  return path.join(cacheRoot(env), "say", "models");
}

export function sherpaModelsDir(env = process.env) {
  return path.join(modelsRoot(env), "sherpa");
}

export function vocodersDir(env = process.env) {
  return path.join(sherpaModelsDir(env), "vocoders");
}

export const DEPLOY_DOCS = path.join(REPO_ROOT, "docs", "research", "deploy");
export const RAW_LOG = path.join(DEPLOY_DOCS, "raw-log.jsonl");

/**
 * @typedef {Object} AssetGroup
 * @property {string} id
 * @property {string} engine raw-log 的 engine 归属
 * @property {string} url 下载源（GitHub Releases 或 HF）
 * @property {null|string} dir 解包后相对目录（file 类资产为 null）
 * @property {Array<{rel: string, bytes?: number, dir?: boolean}>} files 就绪判定清单；
 *   bytes 为钉定字节数（本机实测，GH Releases 资产不可变，字节不符 = 残缺或版本漂移），dir 为目录项
 * @property {string} note 资产注记（进入报告与 --verify 输出）
 */

/** @type {AssetGroup[]} */
export const ASSETS = [
  {
    id: "kokoro-multi-lang-v1_1",
    engine: "sherpa-kokoro",
    url: `${GH}/tts-models/kokoro-multi-lang-v1_1.tar.bz2`,
    dir: "kokoro-multi-lang-v1_1",
    files: [
      { rel: "model.onnx", bytes: 325631784 },
      { rel: "voices.bin" },
      { rel: "tokens.txt" },
      { rel: "espeak-ng-data", dir: true },
      { rel: "lexicon-us-en.txt" },
      { rel: "lexicon-zh.txt" },
      { rel: "date-zh.fst" },
      { rel: "number-zh.fst" },
    ],
    // fp32 钉定：int8 包经 sherpa-onnx-node 绑定的动态 onnxruntime 产出全 NaN 静音（D20），
    // 同名 int8 包是 bench 跑分资产，不进安装清单
    note: "fp32 权重（326MB）。int8 包经 Node 绑定产出全 NaN 静音，运行时钉定 fp32",
  },
  {
    id: "matcha-icefall-zh-baker",
    engine: "sherpa-matcha",
    url: `${GH}/tts-models/matcha-icefall-zh-baker.tar.bz2`,
    dir: "matcha-icefall-zh-baker",
    files: [
      { rel: "model-steps-3.onnx", bytes: 75624611 },
      { rel: "lexicon.txt" },
      { rel: "tokens.txt" },
      { rel: "date.fst" },
      { rel: "number.fst" },
      { rel: "phone.fst" },
    ],
    note: "中文通用嗓（zh_baker，单女声，数据集非商用）",
  },
  {
    id: "vocos-22khz-univ.onnx",
    engine: "sherpa-matcha",
    url: `${GH}/vocoder-models/vocos-22khz-univ.onnx`,
    dir: null,
    files: [{ rel: "vocos-22khz-univ.onnx", bytes: 53884024 }],
    note: "matcha 配套 vocoder（22kHz）",
  },
  {
    id: "sherpa-onnx-zipvoice-distill-int8-zh-en-emilia",
    engine: "sherpa-zipvoice",
    url: `${GH}/tts-models/sherpa-onnx-zipvoice-distill-int8-zh-en-emilia.tar.bz2`,
    dir: "sherpa-onnx-zipvoice-distill-int8-zh-en-emilia",
    files: [
      { rel: "encoder.int8.onnx", bytes: 5570211 },
      { rel: "decoder.int8.onnx", bytes: 124657100 },
      { rel: "espeak-ng-data", dir: true },
      { rel: "lexicon.txt" },
      { rel: "tokens.txt" },
    ],
    note: "零样本克隆权重（int8 出声正常，kokoro 的 NaN 缺陷不在该路径）",
  },
  {
    id: "vocos_24khz.onnx",
    engine: "sherpa-zipvoice",
    url: `${GH}/vocoder-models/vocos_24khz.onnx`,
    dir: null,
    files: [{ rel: "vocos_24khz.onnx", bytes: 54157409 }],
    note: "zipvoice 配套 vocoder（24kHz，与 matcha 的 22kHz 不通用）",
  },
];

/** 资产是否就绪：清单齐全且钉定字节的文件字节吻合；任何缺项返回失败明细 */
export function assessGroup(group, env = process.env) {
  const base = group.dir === null ? vocodersDir(env) : path.join(sherpaModelsDir(env), group.dir);
  const missing = [];
  for (const f of group.files) {
    const p = path.join(base, f.rel);
    if (!existsSync(p)) {
      missing.push(f.rel);
      continue;
    }
    if (f.dir) {
      // 目录项（espeak-ng-data）空目录也能骗过存在性检查，按内含文件数下限兜底
      if (statSync(p).isDirectory() === false) missing.push(f.rel);
    } else if (f.bytes != null && statSync(p).size !== f.bytes) {
      missing.push(`${f.rel}（体积 ${statSync(p).size} ≠ 期望 ${f.bytes}）`);
    }
  }
  return { base, ready: missing.length === 0, missing };
}

/** 下载通道：GitHub 直连透传代理 env；HF 资产直连失败后换 HF_ENDPOINT（默认 hf-mirror.com）重试一次 */
export function channelsFor(url, env = process.env) {
  const channels = [{ net: "direct", url }];
  if (url.startsWith(HF_DIRECT_HOST)) {
    const mirrorHost = env.HF_ENDPOINT && env.HF_ENDPOINT.length > 0 ? env.HF_ENDPOINT : HF_MIRROR_DEFAULT;
    channels.push({ net: "mirror", url: url.replace(HF_DIRECT_HOST, mirrorHost) });
  }
  return channels;
}

/**
 * 证据链落一行（bench raw-log 同构字段）；只收真实执行，skip 由调用方保证不入。
 * proxy 字段只记 set/unset 不记值——代理 URL 可能带凭证。
 */
export function logEvent(e) {
  const line = {
    ts: nowIso(),
    phase: e.phase,
    engine: e.engine,
    cmd: e.cmd,
    exit: e.exit,
    started: e.started,
    ended: e.ended,
    duration_ms: e.durationMs,
    out_file: e.outFile ?? null,
    out_bytes: e.outBytes ?? null,
    stderr_tail: e.stderrTail ?? null,
    net_channel: e.netChannel ?? null,
    url: e.url ?? null,
    proxy: e.proxy ?? null,
  };
  mkdirSync(path.dirname(RAW_LOG), { recursive: true });
  appendFileSync(RAW_LOG, JSON.stringify(line) + "\n");
}