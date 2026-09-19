// sherpa spawn 通道：kokoro/matcha/zipvoice 三适配器共厂。
// 每次合成独立 spawn 一个进程，测量面 = 进程启动 + 模型加载 + 合成全链路；
// cold/hot 由 runner 按调用序区分（同格前 3 次 cold、后 3 次 page cache 热）。
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { KOKORO_DIR, MATCHA_DIR, SHERPA_BIN, VOCOS_22K, VOCOS_24K, ZIPVOICE_DIR } from "../assets.mjs";
import { runCmd } from "../exec.mjs";
import { ZIPVOICE_NUM_STEPS, ZIPVOICE_REFERENCE_AUDIO, ZIPVOICE_REFERENCE_TEXT } from "./sherpa-specs.mjs";

const NUM_THREADS = "--num-threads=2";
const TIMEOUT_MS = 5 * 60 * 1000;

/**
 * @param {object} spec
 * @param {string} spec.engine raw-log engine 归属
 * @param {string} spec.model raw-log model 字段
 * @param {string[]} spec.required 必须在盘路径清单（缺失即通道级 N/A 留证，不带病跑分）
 * @param {string[]} spec.args 模型专属参数（--output-filename 与文本由工厂追加）
 */
function spawnAdapter({ engine, model, required, args }) {
  return {
    engine,
    channel: "spawn",
    model,
    paired: false,
    async available() {
      const missing = [SHERPA_BIN, ...required].filter((p) => !existsSync(p));
      return missing.length === 0
        ? { ok: true }
        : { ok: false, reason: `必需路径缺失: ${missing.join(", ")}`, cmd: `existence-check ${SHERPA_BIN}` };
    },
    async measure({ text, rawPath }) {
      const outFile = `${rawPath}.wav`;
      const cmd = [SHERPA_BIN, ...args, NUM_THREADS, `--output-filename=${outFile}`, text];
      const r = await runCmd(cmd, { timeoutMs: TIMEOUT_MS });
      return {
        rows: [
          {
            model,
            exit: r.exit,
            durationMs: r.durationMs,
            started: r.started,
            ended: r.ended,
            cmdStr: r.cmdStr,
            outFile,
            outBytes: existsSync(outFile) ? statSync(outFile).size : 0,
            stderrTail: r.stderrTail,
          },
        ],
      };
    },
  };
}

export const kokoroSpawn = spawnAdapter({
  engine: "sherpa-kokoro",
  model: "kokoro-int8-multi-lang-v1_1",
  required: [
    path.join(KOKORO_DIR, "model.int8.onnx"),
    path.join(KOKORO_DIR, "voices.bin"),
    path.join(KOKORO_DIR, "tokens.txt"),
    path.join(KOKORO_DIR, "espeak-ng-data"),
    path.join(KOKORO_DIR, "lexicon-us-en.txt"),
    path.join(KOKORO_DIR, "lexicon-zh.txt"),
    path.join(KOKORO_DIR, "date-zh.fst"),
    path.join(KOKORO_DIR, "number-zh.fst"),
  ],
  args: [
    `--kokoro-model=${path.join(KOKORO_DIR, "model.int8.onnx")}`,
    `--kokoro-voices=${path.join(KOKORO_DIR, "voices.bin")}`,
    `--kokoro-tokens=${path.join(KOKORO_DIR, "tokens.txt")}`,
    `--kokoro-data-dir=${path.join(KOKORO_DIR, "espeak-ng-data")}`,
    `--kokoro-lexicon=${path.join(KOKORO_DIR, "lexicon-us-en.txt")},${path.join(KOKORO_DIR, "lexicon-zh.txt")}`,
    `--tts-rule-fsts=${path.join(KOKORO_DIR, "date-zh.fst")},${path.join(KOKORO_DIR, "number-zh.fst")}`,
    // v1_1 的 sid 映射与 v1_0 完全不同（0=af_maple），钉死 sid 保证四文本同音色可比
    "--sid=0",
  ],
});

export const matchaSpawn = spawnAdapter({
  engine: "sherpa-matcha",
  model: "matcha-icefall-zh-baker",
  required: [
    path.join(MATCHA_DIR, "model-steps-3.onnx"),
    VOCOS_22K,
    path.join(MATCHA_DIR, "lexicon.txt"),
    path.join(MATCHA_DIR, "tokens.txt"),
    path.join(MATCHA_DIR, "dict"),
    path.join(MATCHA_DIR, "date.fst"),
    path.join(MATCHA_DIR, "number.fst"),
    path.join(MATCHA_DIR, "phone.fst"),
  ],
  // 单语中文模型：英文文本不报错但产出退化空音频（exit 0 + 数据字节远低于下限），
  // 对应格在报告 na_cells 如实标 N/A，退化行本身即佐证，不做人为过滤
  args: [
    `--matcha-acoustic-model=${path.join(MATCHA_DIR, "model-steps-3.onnx")}`,
    `--matcha-vocoder=${VOCOS_22K}`,
    `--matcha-lexicon=${path.join(MATCHA_DIR, "lexicon.txt")}`,
    `--matcha-tokens=${path.join(MATCHA_DIR, "tokens.txt")}`,
    `--tts-rule-fsts=${path.join(MATCHA_DIR, "date.fst")},${path.join(MATCHA_DIR, "number.fst")},${path.join(MATCHA_DIR, "phone.fst")}`,
  ],
});

export const zipvoiceSpawn = spawnAdapter({
  engine: "sherpa-zipvoice",
  model: "zipvoice-distill-int8-zh-en-emilia",
  required: [
    path.join(ZIPVOICE_DIR, "encoder.int8.onnx"),
    path.join(ZIPVOICE_DIR, "decoder.int8.onnx"),
    path.join(ZIPVOICE_DIR, "espeak-ng-data"),
    path.join(ZIPVOICE_DIR, "lexicon.txt"),
    path.join(ZIPVOICE_DIR, "tokens.txt"),
    VOCOS_24K,
    ZIPVOICE_REFERENCE_AUDIO,
  ],
  args: [
    `--zipvoice-encoder=${path.join(ZIPVOICE_DIR, "encoder.int8.onnx")}`,
    `--zipvoice-decoder=${path.join(ZIPVOICE_DIR, "decoder.int8.onnx")}`,
    `--zipvoice-data-dir=${path.join(ZIPVOICE_DIR, "espeak-ng-data")}`,
    `--zipvoice-lexicon=${path.join(ZIPVOICE_DIR, "lexicon.txt")}`,
    `--zipvoice-tokens=${path.join(ZIPVOICE_DIR, "tokens.txt")}`,
    `--zipvoice-vocoder=${VOCOS_24K}`,
    `--reference-audio=${ZIPVOICE_REFERENCE_AUDIO}`,
    `--reference-text=${ZIPVOICE_REFERENCE_TEXT}`,
    `--num-steps=${ZIPVOICE_NUM_STEPS}`,
  ],
});
