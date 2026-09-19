import { createDefaultRegistry } from "./engines/index.ts";
import { createNodeHost, SYSTEM_SAY_BIN } from "./host.ts";
import { resolvePaths } from "./paths.ts";
import { run, type RunDeps } from "./speak.ts";

export { parseArgv, type CliRequest } from "./cli.ts";
export { DEFAULT_RATE_WPM, parseConfigFile, resolveConfig } from "./config.ts";
export { createRegistry, createDefaultRegistry, createSystemEngine, parseSayVoiceList } from "./engines/index.ts";
export { EngineError, NotImplementedError } from "./errors.ts";
export { defineExecutor } from "./executor.ts";
export { createNodeHost, SYSTEM_SAY_BIN, type Host } from "./host.ts";
export { resolvePaths } from "./paths.ts";
export { run, type RunDeps } from "./speak.ts";
export type * from "./types.ts";

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
