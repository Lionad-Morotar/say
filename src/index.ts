import { createDefaultRegistry } from "./engines/index.ts";
import { createNodeHost, SYSTEM_SAY_BIN } from "./host.ts";
import { resolvePaths } from "./paths.ts";
import { run } from "./speak.ts";
import type { RunDeps } from "./deps.ts";

export { parseArgv, type CliRequest } from "./cli.ts";
export { DEFAULT_ENGINE, DEFAULT_RATE_WPM, parseConfigFile, resolveConfig } from "./config.ts";
export {
  deliver,
  deliverAndExit,
  startTiming,
  stagingPath,
  type Delivery,
  type DeliveryResult,
  type Timing,
} from "./delivery.ts";
export { type RunDeps } from "./deps.ts";
export {
  SHERPA_ENGINE,
  SYSTEM_ENGINE,
  createDefaultRegistry,
  createRegistry,
  createSherpaEngine,
  createSystemEngine,
  parseSayVoiceList,
  routeEngine,
  type EngineRegistry,
  type EngineRoute,
} from "./engines/index.ts";
export { DEFAULT_VOICE, wpmToSpeed } from "./engines/sherpa.ts";
export { KOKORO_VOICE_COUNT, KOKORO_VOICES, kokoroSidOf, isSherpaVoice } from "./engines/sherpa-voices.ts";
export { EngineError, NotImplementedError, PlaybackError } from "./errors.ts";
export { defineExecutor } from "./executor.ts";
export { FALLBACK_PREFIX, attemptSpeak, recover, speakWith, type Attempt } from "./fallback.ts";
export { createNodeHost, SYSTEM_SAY_BIN, type Host } from "./host.ts";
export {
  CHUNK_BUDGET,
  CHUNK_THRESHOLD,
  FIRST_CHUNK_BUDGET,
  approxTokens,
  chunkText,
  normalizeText,
  splitSentences,
} from "./normalize.ts";
export { resolvePaths } from "./paths.ts";
export { speakChunked, speakOnce, type SpeakContext } from "./pipeline.ts";
export { AFPLAY_BIN, playFile } from "./player.ts";
export { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, fail, writeDebug, type Outcome } from "./report.ts";
export { run } from "./speak.ts";
export { withStderrMuted } from "./stderr.ts";
export type * from "./types.ts";
export { concatSamples, encodeWav } from "./wav.ts";

/** 组装真实依赖并执行一次调用，返回进程退出码 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const host = createNodeHost();
  const deps: RunDeps = {
    host,
    paths: resolvePaths(host.env),
    registry: createDefaultRegistry(host),
    sayBin: SYSTEM_SAY_BIN,
  };
  return run(argv, deps);
}
