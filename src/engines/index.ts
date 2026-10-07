import { SYSTEM_SAY_BIN, type Host } from "../host.ts";
import { resolvePaths, sayLabEngineDir } from "../paths.ts";
import type { EngineAdapter, ResolvedConfig } from "../types.ts";
import { createFireredEngine } from "./firered.ts";
import type { FireredSynth } from "./firered-binding.ts";
import { createGptsovitsEngine } from "./gptsovits.ts";
import type { GptsovitsSynth } from "./gptsovits-binding.ts";
import { createIndexttsEngine } from "./indextts.ts";
import type { IndexttsSynth } from "./indextts-binding.ts";
import { synthesizeWithBinding, type SherpaSynth } from "./sherpa-binding.ts";
import { isSherpaVoice } from "./sherpa-voices.ts";
import { createSherpaEngine } from "./sherpa.ts";
import { createSystemEngine, parseSayVoiceList } from "./system.ts";
import { createVoxcpmEngine } from "./voxcpm.ts";
import type { VoxcpmStreamSynth } from "./voxcpm-binding.ts";
import { createZipvoiceEngine } from "./zipvoice.ts";
import { synthesizeWithBinding as synthesizeWithZipvoiceBinding, type ZipvoiceSynth } from "./zipvoice-binding.ts";

export const SHERPA_ENGINE = "sherpa";
export const SYSTEM_ENGINE = "system";
export const ZIPVOICE_ENGINE = "zipvoice";
export const GPTSOVITS_ENGINE = "gptsovits";
export const VOXCPM_ENGINE = "voxcpm";
export const INDEXTTS_ENGINE = "indextts";
export const FIRERED_ENGINE = "firered";

export interface EngineRegistry {
  get(name: string): EngineAdapter | undefined;
  names(): string[];
  /** 登记序的全量清单：音色认领仲裁要按登记序逐个询问 */
  all(): readonly EngineAdapter[];
}

export function createRegistry(engines: readonly EngineAdapter[]): EngineRegistry {
  const byName = new Map(engines.map((engine) => [engine.name, engine]));
  return {
    get: (name) => byName.get(name),
    names: () => [...byName.keys()],
    all: () => engines,
  };
}

export interface EngineRoute {
  engine: EngineAdapter | undefined;
  /** 路由可能改写音色归属，实际下传的名字以这里为准 */
  voice: string | null;
}

/**
 * 音色名与引擎选择的仲裁。音色空间三分：
 *
 * 1. 显式点名 system 引擎时原样下传——系统嗓是开放集，音色语义由 say 自己兜，
 *    用户点名 system 就是点名要那套行为，不替他改主意；
 * 2. 显式点名的引擎对音色名有最优先认领权——多引擎共享认领集时（gptsovits 与
 *    zipvoice 用同一角色目录、同一 splitVoiceName 语义），纯登记序仲裁会让先登记者
 *    静默接管显式选择，`-e gptsovits -v frieren` 永远到不了 gptsovits；
 * 3. 其余引擎按登记序认领音色名（内嵌表 / 角色目录），认领即归属；
 * 4. 系统嗓开放集（`-v Tingting` 的意图是那个具体嗓子）——认领失败后按系统嗓清单委派，
 *    迁移过来的既有调用不因默认引擎是神经引擎而失效；
 * 5. 谁也不认领的名字——交回配置引擎报「未登记」并触发回退：
 *    `-v nosuch` 因此得到系统嗓 + 一行原因 + exit 0，而不是被系统 say 静默忽略成默认嗓。
 */
export async function routeEngine(config: ResolvedConfig, registry: EngineRegistry): Promise<EngineRoute> {
  const configured = registry.get(config.engine);
  const voice = config.voice;
  if (voice === null || config.engine === SYSTEM_ENGINE) return { engine: configured, voice };
  if (configured === undefined) return { engine: undefined, voice };
  if (configured.ownsVoice?.(voice)) return { engine: configured, voice };
  for (const engine of registry.all()) {
    if (engine.name === SYSTEM_ENGINE) continue;
    if (engine.ownsVoice?.(voice)) return { engine, voice };
  }
  const delegate = registry.get(SYSTEM_ENGINE);
  if (delegate !== undefined) {
    const voices = await delegate.listVoices();
    if (voices.some((entry) => entry.name === voice)) return { engine: delegate, voice };
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
  cloneSynth: ZipvoiceSynth = synthesizeWithZipvoiceBinding,
  gptsovitsSynth?: GptsovitsSynth,
  voxcpmSynth?: VoxcpmStreamSynth,
  indexttsSynth?: IndexttsSynth,
  fireredSynth?: FireredSynth,
): EngineRegistry {
  const paths = resolvePaths(host.env);
  const gptsovits = createGptsovitsEngine({
    host,
    labDir: sayLabEngineDir(host.env, "gptsovits"),
    voicesDir: paths.voicesDir,
    ...(gptsovitsSynth !== undefined ? { synth: gptsovitsSynth } : {}),
  });
  const voxcpm = createVoxcpmEngine({
    host,
    labDir: sayLabEngineDir(host.env, "voxcpm"),
    voicesDir: paths.voicesDir,
    ...(voxcpmSynth !== undefined ? { synth: voxcpmSynth } : {}),
  });
  const indextts = createIndexttsEngine({
    host,
    labDir: sayLabEngineDir(host.env, "indextts"),
    voicesDir: paths.voicesDir,
    ...(indexttsSynth !== undefined ? { synth: indexttsSynth } : {}),
  });
  const firered = createFireredEngine({
    host,
    labDir: sayLabEngineDir(host.env, "firered"),
    voicesDir: paths.voicesDir,
    ...(fireredSynth !== undefined ? { synth: fireredSynth } : {}),
  });
  return createRegistry([
    createSherpaEngine({ host, modelsDir: paths.modelsDir, synth }),
    createZipvoiceEngine({ host, modelsDir: paths.modelsDir, voicesDir: paths.voicesDir, synth: cloneSynth }),
    gptsovits,
    voxcpm,
    indextts,
    firered,
    createSystemEngine(host, sayBin),
  ]);
}

export { createSherpaEngine, createSystemEngine, createZipvoiceEngine, createGptsovitsEngine, createVoxcpmEngine, createIndexttsEngine, createFireredEngine, parseSayVoiceList };
export type { SherpaSynth, ZipvoiceSynth };
export { isSherpaVoice };