import type { EngineRegistry } from "./engines/index.ts";
import type { Host } from "./host.ts";
import type { SayPaths } from "./types.ts";

/**
 * 一次调用所需的全部外部依赖。单独成模块是为了让交付、回退与流水编排都能引用同一个形状，
 * 又不必反过来依赖 CLI 入口——否则编排层与入口会互相 import。
 */
export interface RunDeps {
  host: Host;
  paths: SayPaths;
  registry: EngineRegistry;
  sayBin: string;
}
