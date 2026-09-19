import { SYSTEM_SAY_BIN, type Host } from "../host.ts";
import { resolvePaths } from "../paths.ts";
import type { EngineAdapter, ResolvedConfig } from "../types.ts";
import { synthesizeWithBinding, type SherpaSynth } from "./sherpa-binding.ts";
import { isSherpaVoice } from "./sherpa-voices.ts";
import { createSherpaEngine } from "./sherpa.ts";
import { createSystemEngine, parseSayVoiceList } from "./system.ts";

export const SHERPA_ENGINE = "sherpa";
export const SYSTEM_ENGINE = "system";

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

export interface EngineRoute {
  engine: EngineAdapter | undefined;
  /** 路由可能改写音色归属，实际下传的名字以这里为准 */
  voice: string | null;
}

/**
 * 音色名与显式引擎选择的仲裁。
 *
 * `-v Tingting` 的意图是那个具体嗓子，而它只存在于系统嗓里；若因为默认引擎是 sherpa
 * 就报「未登记音色」，用户从 say 迁移过来的既有调用会全部失效。
 * 所以配置引擎不是 system 时，认不出的音色名委派给系统嗓解释。
 * 反过来，用户显式写了 `engine = "system"` 就是点名要系统嗓，
 * 此时即便填了 sherpa 的音色名也原样下传，不替他改主意。
 */
export function routeEngine(config: ResolvedConfig, registry: EngineRegistry): EngineRoute {
  const configured = registry.get(config.engine);
  const voice = config.voice;
  if (voice === null || config.engine === SYSTEM_ENGINE) return { engine: configured, voice };
  if (configured !== undefined && configured.name !== SYSTEM_ENGINE && !isSherpaVoice(voice)) {
    const delegate = registry.get(SYSTEM_ENGINE);
    if (delegate !== undefined) return { engine: delegate, voice };
  }
  return { engine: configured, voice };
}

/**
 * 登记即接线：实现 EngineAdapter 后在这里加一行，config 的 `engine = "<name>"`
 * 与环境变量 SAY_ENGINE 立刻能切过去，不需要改编排层。
 */
export function createDefaultRegistry(
  host: Host,
  sayBin: string = SYSTEM_SAY_BIN,
  synth: SherpaSynth = synthesizeWithBinding,
): EngineRegistry {
  return createRegistry([
    createSherpaEngine({ host, modelsDir: resolvePaths(host.env).modelsDir, synth }),
    createSystemEngine(host, sayBin),
  ]);
}

export { createSherpaEngine, createSystemEngine, parseSayVoiceList };
export type { SherpaSynth };
