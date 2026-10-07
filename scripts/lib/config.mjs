// voicepack 路径与常量：素材资产（版权内容）只落 VOICES_DIR 与 VOICEPACK_DOCS，两处均不入 git。
import { homedir } from "node:os";
import path from "node:path";
import { CACHE, MODELS, TOOLS, SHERPA_VERSION } from "../../bench/lib/config.mjs";

export const REPO = path.resolve(import.meta.dirname, "..", "..");

/** 角色素材资产位（非可再生资产，蓝图 D11：不入 cache） */
export const VOICES_DIR = path.join(homedir(), ".local", "share", "say", "voices");
/** peon-ping 注册表与 D.Va 增补包：17 条游戏原生干音，GPT-SoVITS 训练集候选（S7），
 * CC-BY-NC-4.0 本机个人使用，资产落 VOICES_DIR 沿用不入 git 纪律 */
export const PEON_REGISTRY_URL = "https://peonping.github.io/registry/index.json";
export const PEON_DVA_DIR = path.join(VOICES_DIR, "dva", "peon-ping");
/** 研究与冒烟产物位（docs/research 全局 ignored） */
export const VOICEPACK_DOCS = path.join(REPO, "docs", "research", "voicepack");
export const RAW_LOG = path.join(VOICEPACK_DOCS, "raw-log.jsonl");
export const REPORT = path.join(VOICEPACK_DOCS, "report.md");
/** 下载中间产物（截取前的完整源音频），不入 git、可清理 */
export const WORK_DIR = path.join(VOICEPACK_DOCS, "work");

export const SHERPA_TTS_BIN = path.join(TOOLS, `sherpa-onnx-v${SHERPA_VERSION}-osx-arm64-static`, "bin", "sherpa-onnx-offline-tts");
export const ZIPVOICE_DIR = path.join(MODELS, "sherpa", "sherpa-onnx-zipvoice-distill-int8-zh-en-emilia");
export const VOCODER_24K = path.join(MODELS, "sherpa", "vocoders", "vocos_24khz.onnx");

export { CACHE, MODELS, TOOLS, SHERPA_VERSION };
