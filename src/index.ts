import { parseConfigFile } from "./config.ts";
import { createDefaultRegistry } from "./engines/index.ts";
import { createNodeHost, SYSTEM_SAY_BIN, type Host } from "./host.ts";
import { resolvePaths } from "./paths.ts";
import { run } from "./speak.ts";
import type { RunDeps } from "./deps.ts";
import type { ConfigFile } from "./types.ts";

export { parseArgv, type CliRequest } from "./cli.ts";
export {
  DEFAULT_ENGINE,
  DEFAULT_LOCALE,
  DEFAULT_RATE_WPM,
  DEFAULT_VOICE_KEY,
  parseConfigFile,
  resolveConfig,
} from "./config.ts";
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
export { runEngineCommand, type LabEngineStatus } from "./engines-command.ts";
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
export { detectLocale, type LocaleLang } from "./locale.ts";
export { run } from "./speak.ts";
export { withStderrMuted } from "./stderr.ts";
export type * from "./types.ts";
export { concatSamples, encodeWav } from "./wav.ts";

/**
 * daemon 接线层的 config 层输入：读盘只为喂 [daemon] 三层解析，坏了静默回落 env/内置两层。
 * 坏文件的归因不在这里打——run() 编排层会照常警告，同一次调用双份刷屏比单点静默更吵。
 */
async function readDaemonConfigFile(host: Host, configFile: string): Promise<ConfigFile | null> {
  if (!host.fileExists(configFile)) return null;
  try {
    const parsed = parseConfigFile(await host.readFileText(configFile));
    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
}

/** 组装真实依赖并执行一次调用，返回进程退出码 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const host = createNodeHost();
  const paths = resolvePaths(host.env);
  const deps: RunDeps = {
    host,
    paths,
    registry: createDefaultRegistry(host, { daemonFile: await readDaemonConfigFile(host, paths.configFile) }),
    sayBin: SYSTEM_SAY_BIN,
  };
  return run(argv, deps);
}
