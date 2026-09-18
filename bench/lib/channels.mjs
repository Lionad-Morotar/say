// 通道注册表。EXPECTED_CHANNELS 钉死矩阵规模（8 通道）——verify 凭它防注册面缩水导致自检放水。
// 适配器随通道实现就位递增注册：系统 say 对照 → sherpa spawn/node → mlx subprocess。
import { mlxAdapter } from "./engines/mlx.mjs";
import { sayAdapter } from "./engines/say.mjs";
import { kokoroNode, matchaNode, zipvoiceNode } from "./engines/sherpa-node.mjs";
import { kokoroSpawn, matchaSpawn, zipvoiceSpawn } from "./engines/sherpa-spawn.mjs";

/** @type {Array<{engine: string, channel: string}>} 完整矩阵（对账公式的分母） */
export const EXPECTED_CHANNELS = [
  { engine: "sherpa-kokoro", channel: "spawn" },
  { engine: "sherpa-kokoro", channel: "node" },
  { engine: "sherpa-matcha", channel: "spawn" },
  { engine: "sherpa-matcha", channel: "node" },
  { engine: "sherpa-zipvoice", channel: "spawn" },
  { engine: "sherpa-zipvoice", channel: "node" },
  { engine: "mlx-qwen3", channel: "subprocess" },
  { engine: "system-say", channel: "spawn" },
];

export const ALL_CHANNELS = [sayAdapter, kokoroSpawn, matchaSpawn, zipvoiceSpawn, kokoroNode, matchaNode, zipvoiceNode, mlxAdapter];
