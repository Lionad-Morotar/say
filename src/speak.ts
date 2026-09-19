import type { CliRequest } from "./cli.ts";
import { parseArgv } from "./cli.ts";
import { parseConfigFile, resolveConfig } from "./config.ts";
import type { EngineRegistry } from "./engines/index.ts";
import { messageOf } from "./errors.ts";
import type { Host } from "./host.ts";
import type { AudioOut, ConfigFile, SayPaths } from "./types.ts";

export interface RunDeps {
  host: Host;
  paths: SayPaths;
  registry: EngineRegistry;
  sayBin: string;
}

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

type TextSource = { ok: true; text: string } | { ok: false; error: string };

function fail(host: Host, message: string): number {
  host.writeStderr(`say: ${message}\n`);
  return EXIT_FAILURE;
}

/** 透传保真优先：stdio 用 inherit，进度条、交互高亮与 `-v ?` 列表都直达终端而非被缓冲 */
async function passthrough(deps: RunDeps, argv: readonly string[]): Promise<number> {
  try {
    const outcome = await deps.host.spawn(deps.sayBin, argv, { stdio: "inherit" });
    if (outcome.exitCode === null) {
      return fail(deps.host, `透传 ${deps.sayBin} 被信号 ${outcome.signal ?? "未知"} 终止`);
    }
    return outcome.exitCode;
  } catch (error) {
    return fail(deps.host, `透传 ${deps.sayBin} 失败：${messageOf(error)}`);
  }
}

/** 位置参数胜过 -f：与 macOS say 实测一致（两者并存时产出时长与仅位置参数逐位相同） */
async function resolveText(
  request: Extract<CliRequest, { kind: "speak" }>,
  host: Host,
): Promise<TextSource> {
  if (request.texts.length > 0) return { ok: true, text: request.texts.join(" ") };
  const source = request.inputFile;
  if (source !== null && source !== "-") {
    try {
      return { ok: true, text: await host.readFileText(source) };
    } catch (error) {
      return { ok: false, error: `读取 ${source} 失败：${messageOf(error)}` };
    }
  }
  try {
    return { ok: true, text: await host.readStdin() };
  } catch (error) {
    return { ok: false, error: `读取标准输入失败：${messageOf(error)}` };
  }
}

async function loadConfigFile(
  host: Host,
  configFile: string,
): Promise<{ file: ConfigFile | null; warnings: string[] }> {
  if (!host.fileExists(configFile)) return { file: null, warnings: [] };
  let text: string;
  try {
    text = await host.readFileText(configFile);
  } catch (error) {
    return { file: null, warnings: [`${configFile} 读取失败，已按默认配置继续：${messageOf(error)}`] };
  }
  const parsed = parseConfigFile(text);
  if (!parsed.ok) {
    return { file: null, warnings: [`${configFile} 解析失败，已按默认配置继续：${parsed.error}`] };
  }
  return { file: parsed.value, warnings: [] };
}

async function deliver(
  host: Host,
  out: AudioOut,
  target: string | null,
): Promise<{ delivered: boolean; error: string | null }> {
  if (out.type !== "file" || target === null || out.path === target) {
    return { delivered: true, error: null };
  }
  // 临时名 → 目标名的原子改名：并发调用各写各的 PID 临时文件，互不覆盖半截产物
  try {
    await host.renameFile(out.path, target);
    return { delivered: true, error: null };
  } catch (error) {
    return { delivered: false, error: `写入 ${target} 失败：${messageOf(error)}` };
  }
}

/**
 * 编排：解析 → 取正文 → 配置三层合并 → 选引擎 → 合成 → 交付。
 * 退出码语义遵循「产生过声音或产物即 0」：只有全程无声无文件才非零。
 */
export async function run(argv: readonly string[], deps: RunDeps): Promise<number> {
  const { host } = deps;
  const request = parseArgv(argv);

  if (request.kind === "passthrough") return passthrough(deps, request.argv);
  if (request.kind === "usage-error") {
    host.writeStderr(`say: ${request.message}\n`);
    return EXIT_USAGE;
  }

  const source = await resolveText(request, host);
  if (!source.ok) return fail(host, source.error);
  // 引擎对空文本会抛错而非产出静音，与 macOS `say ""` 的静默成功对齐只能在这一层短路
  if (source.text.trim().length === 0) return EXIT_OK;

  const loaded = await loadConfigFile(host, deps.paths.configFile);
  for (const warning of loaded.warnings) host.writeStderr(`say: ${warning}\n`);

  const resolution = resolveConfig({
    env: host.env,
    file: loaded.file,
    flags: { voice: request.voice, rateWpm: request.rateWpm },
  });
  for (const warning of resolution.warnings) host.writeStderr(`say: ${warning}\n`);
  const config = resolution.config;

  const engine = deps.registry.get(config.engine);
  if (engine === undefined) {
    return fail(
      host,
      `未登记的引擎 "${config.engine}"（已登记：${deps.registry.names().join(", ") || "无"}）`,
    );
  }
  const availability = await engine.isAvailable();
  if (!availability.ok) {
    return fail(host, `引擎 "${engine.name}" 不可用：${availability.reason}`);
  }

  const target = request.output;
  const temp = target === null ? null : `${target}.${host.pid}.tmp`;

  let out: AudioOut;
  try {
    out = await engine.speak(source.text, {
      voice: config.voice,
      rateWpm: config.rateWpm,
      output: temp,
    });
  } catch (error) {
    return fail(host, messageOf(error));
  }

  const delivery = await deliver(host, out, target);
  if (!delivery.delivered) return fail(host, delivery.error ?? "产物交付失败");
  return EXIT_OK;
}
