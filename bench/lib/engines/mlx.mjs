// mlx-audio Qwen3-TTS 子进程通道：每次合成独立进程重新加载约 2GB 权重，
// cold/hot 差异仅为 OS page cache（与 spawn 系通道同口径，非常驻进程面）。
// --join_audio 必带：默认按分段落 _000 后缀多文件，证据行与样本转制需要单文件输出。
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { MLX_TTS_ENTRY, QWEN3_DIR } from "../assets.mjs";
import { TEXTS } from "../config.mjs";
import { runCmd } from "../exec.mjs";

// 语言码显式对齐文本语言：默认探测实测把中文文本判成 en；mixed 走 auto 交由模型内部 code-switching
const LANG_CODE = { en: "english", zh: "chinese", mixed: "auto" };
// 音色钉模型预设 vivian（CustomVoice 9 音色之一，zh/en 全支持），四文本同音色可比
const VOICE = "vivian";
const TIMEOUT_MS = 10 * 60 * 1000;

export const mlxAdapter = {
  engine: "mlx-qwen3",
  channel: "subprocess",
  model: "Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
  paired: false,
  async available() {
    const missing = [MLX_TTS_ENTRY, path.join(QWEN3_DIR, "model.safetensors")].filter((p) => !existsSync(p));
    return missing.length === 0
      ? { ok: true }
      : { ok: false, reason: `必需路径缺失: ${missing.join(", ")}`, cmd: `existence-check ${MLX_TTS_ENTRY}` };
  },
  async measure({ textid, text, rawPath }) {
    const outFile = `${rawPath}.wav`;
    const cmd = [
      MLX_TTS_ENTRY,
      "--model", QWEN3_DIR,
      "--text", text,
      "--voice", VOICE,
      "--lang_code", LANG_CODE[TEXTS[textid].lang],
      "--join_audio",
      "--output_path", path.dirname(rawPath),
      "--file_prefix", path.basename(rawPath),
      "--audio_format", "wav",
    ];
    const r = await runCmd(cmd, { timeoutMs: TIMEOUT_MS });
    return {
      rows: [
        {
          model: `qwen3-tts-0.6b-8bit-${VOICE}`,
          exit: r.exit,
          durationMs: r.durationMs,
          started: r.started,
          ended: r.ended,
          cmdStr: r.cmdStr,
          outFile: existsSync(outFile) ? outFile : null,
          outBytes: existsSync(outFile) ? statSync(outFile).size : 0,
          stderrTail: r.stderrTail,
        },
      ],
    };
  },
};
