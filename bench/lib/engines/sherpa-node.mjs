// Node 绑定通道：paired 适配器，单次 worker 进程产出 cold+hot 两行。
// cold = 父进程 spawn 时刻 → 首次合成落盘完成（含 node 启动、绑定与模型加载、首合成）；
// hot = 两次合成的区间（模型驻留纯合成+写盘），即常驻 daemon 服务的延迟面。
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { REPO } from "../config.mjs";
import { runCmd } from "../exec.mjs";
import { NODE_ENGINE_SPECS } from "./sherpa-specs.mjs";

const WORKER = path.join(import.meta.dirname, "node-worker.mjs");
const ADDON_MARKER = path.join(REPO, "node_modules", "sherpa-onnx-node");
const TIMEOUT_MS = 5 * 60 * 1000;

/**
 * worker stdout 的计时锚点负载（形状与 node-worker.mjs 的 result 一致）。
 * 字段访问全部走本 typedef：锚点缺失时构造 Date 会抛错中断而非静默 NaN 入证据日志。
 * @typedef {Object} WorkerResult
 * @property {boolean} ok
 * @property {number} t_entry
 * @property {number} [t_loaded]
 * @property {number} [t_first]
 * @property {number} [t_second]
 * @property {number} [bytes_first]
 * @property {number} [bytes_second]
 * @property {number} [sampleRate]
 * @property {number} [numSamples]
 * @property {string} [error]
 */

function nodeAdapter(key) {
  const spec = NODE_ENGINE_SPECS[key];
  return {
    engine: spec.engine,
    channel: "node",
    model: spec.model,
    paired: true,
    async available() {
      const missing = [WORKER, ADDON_MARKER, ...spec.required].filter((p) => !existsSync(p));
      return missing.length === 0
        ? { ok: true }
        : { ok: false, reason: `必需路径缺失: ${missing.join(", ")}`, cmd: `existence-check ${WORKER}` };
    },
    async measure({ text, rawPath, run }) {
      const outFile = `${rawPath}.wav`;
      const cmd = [process.execPath, WORKER, "--engine", key, "--text", text, "--out", outFile];
      const r = await runCmd(cmd, { timeoutMs: TIMEOUT_MS });
      /** @type {WorkerResult|null} */
      let w = null;
      try {
        w = JSON.parse(r.stdout.trim().split("\n").pop() ?? "");
      } catch {
        // worker 输出非 JSON（崩溃/绑定加载失败）按失败行处理
      }
      // 锚点齐全才走计时分解，缺任一按失败行落 log（防 new Date(undefined) 抛错中断整个矩阵）
      if (!w || !w.ok || !w.t_first || !w.t_second || !existsSync(outFile)) {
        return {
          rows: [
            {
              model: spec.model,
              exit: r.exit ?? 1,
              durationMs: r.durationMs,
              started: r.started,
              ended: r.ended,
              cmdStr: r.cmdStr,
              outFile: null,
              outBytes: 0,
              stderrTail: ((w && w.error) || r.stderrTail || "worker 无有效 JSON 输出").slice(-500),
            },
          ],
        };
      }
      // 冷段以父进程 spawn 时刻为起点：与 spawn 通道同口径覆盖进程启动开销
      const tSpawn = Date.parse(r.started);
      return {
        rows: [
          {
            model: spec.model, mode: "cold", run, exit: 0,
            durationMs: w.t_first - tSpawn,
            started: r.started, ended: new Date(w.t_first).toISOString(),
            cmdStr: r.cmdStr, outFile, outBytes: w.bytes_first ?? statSync(outFile).size, stderrTail: "",
          },
          {
            model: spec.model, mode: "hot", run, exit: 0,
            durationMs: w.t_second - w.t_first,
            started: new Date(w.t_first).toISOString(), ended: new Date(w.t_second).toISOString(),
            cmdStr: r.cmdStr, outFile, outBytes: w.bytes_second ?? statSync(outFile).size, stderrTail: "",
          },
        ],
      };
    },
  };
}

export const kokoroNode = nodeAdapter("kokoro");
export const matchaNode = nodeAdapter("matcha");
export const zipvoiceNode = nodeAdapter("zipvoice");
