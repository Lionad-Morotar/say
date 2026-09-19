#!/usr/bin/env node
// Node 绑定通道 worker：单进程内加载模型一次、同文本合成并写盘两次，stdout 输出计时锚点 JSON。
// 与适配器进程隔离：native 绑定只在 worker 内加载，可用性检查与 verify 不触碰 .node 文件。
// 落盘面与 spawn 通道对齐：cold 段含首次合成+写盘，hot 段含二次合成+写盘（模型驻留态）。
import { statSync } from "node:fs";
import process from "node:process";
import sherpa from "sherpa-onnx-node";
import { NODE_ENGINE_SPECS } from "./sherpa-specs.mjs";

const argv = process.argv.slice(2);
const get = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

/** @type {{ok: boolean, t_entry: number, t_loaded?: number, t_first?: number, t_second?: number, bytes_first?: number, bytes_second?: number, sampleRate?: number, numSamples?: number, error?: string}} */
const result = { ok: false, t_entry: Date.now() };

try {
  const spec = NODE_ENGINE_SPECS[get("engine") ?? ""];
  const text = get("text");
  const out = get("out");
  if (!spec) throw new Error(`unknown engine: ${get("engine")}`);
  if (!text || !out) throw new Error("missing --text or --out");

  const tts = new sherpa.OfflineTts(spec.ttsConfig());
  result.t_loaded = Date.now();
  const generationConfig = spec.generation(sherpa);

  const a1 = tts.generate({ text, sid: 0, speed: 1.0, generationConfig });
  sherpa.writeWave(out, { samples: a1.samples, sampleRate: a1.sampleRate });
  result.t_first = Date.now();
  result.bytes_first = statSync(out).size;

  const a2 = tts.generate({ text, sid: 0, speed: 1.0, generationConfig });
  sherpa.writeWave(out, { samples: a2.samples, sampleRate: a2.sampleRate });
  result.t_second = Date.now();
  result.bytes_second = statSync(out).size;

  result.sampleRate = a2.sampleRate;
  result.numSamples = a2.samples.length;
  // 1.13.8 绑定未暴露 free/release（句柄随 GC/进程退出释放）；worker 每次调用即弃进程，无需显式清理
  result.ok = true;
} catch (e) {
  result.error = String((e && e.stack) || e);
}

console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
