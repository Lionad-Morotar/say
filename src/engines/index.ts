import { SYSTEM_SAY_BIN, type Host } from "../host.ts";
import type { EngineAdapter } from "../types.ts";
import { createSystemEngine, parseSayVoiceList } from "./system.ts";

export interface EngineRegistry {
  get(name: string): EngineAdapter | undefined;
  names(): string[];
}

export function createRegistry(engines: readonly EngineAdapter[]): EngineRegistry {
  const byName = new Map(engines.map((engine) => [engine.name, engine]));
  return {
    get: (name) => byName.get(name),
    names: () => [...byName.keys()],
  };
}

/**
 * 登记即接线：实现 EngineAdapter 后在这里加一行，config 的 `engine = "<name>"`
 * 与环境变量 SAY_ENGINE 立刻能切过去，不需要改编排层。
 */
export function createDefaultRegistry(host: Host, sayBin: string = SYSTEM_SAY_BIN): EngineRegistry {
  return createRegistry([createSystemEngine(host, sayBin)]);
}

export { createSystemEngine, parseSayVoiceList };
