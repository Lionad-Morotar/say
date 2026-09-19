import { homedir } from "node:os";
import path from "node:path";
import type { EnvMap, SayPaths } from "./types.ts";

/** 空串视同未设：shell 里 `export XDG_CONFIG_HOME=` 是常见的「取消覆盖」写法，不该被当成根目录 */
function rootDir(override: string | undefined, fallback: string): string {
  return override && override.length > 0 ? override : fallback;
}

/**
 * 解析三处 XDG 落点。env 显式传入而非直接读 process.env，
 * 让单测能用临时 HOME 覆盖，绝不触碰真实用户配置目录。
 */
export function resolvePaths(env: EnvMap): SayPaths {
  const home = rootDir(env.HOME, homedir());
  const config = rootDir(env.XDG_CONFIG_HOME, path.join(home, ".config"));
  const cache = rootDir(env.XDG_CACHE_HOME, path.join(home, ".cache"));
  const data = rootDir(env.XDG_DATA_HOME, path.join(home, ".local", "share"));
  return {
    configFile: path.join(config, "say", "config.toml"),
    modelsDir: path.join(cache, "say", "models"),
    voicesDir: path.join(data, "say", "voices"),
  };
}
