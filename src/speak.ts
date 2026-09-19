import { join } from "node:path";
import type { CliRequest } from "./cli.ts";
import { parseArgv } from "./cli.ts";
import { parseConfigFile, resolveConfig } from "./config.ts";
import { SYSTEM_ENGINE, routeEngine, type EngineRegistry } from "./engines/index.ts";
import { messageOf } from "./errors.ts";
import type { Host } from "./host.ts";
import { playFile } from "./player.ts";
import type { AudioOut, ConfigFile, EngineAdapter, ResolvedConfig, SayPaths, SpeakOptions } from "./types.ts";
import { encodeWav } from "./wav.ts";

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

interface Delivery {
  /** `-o` 的最终目标；null 表示要出声卡而不是落盘 */
  target: string | null;
  /** 目标的 PID 临时名，引擎自己写盘时用的就是它 */
  temp: string | null;
}

type DeliveryResult = { delivered: boolean; error: string | null };

const DELIVERED: DeliveryResult = { delivered: true, error: null };

/** 播放用的暂存 wav。带 PID 是为了并发调用各写各的，互不覆盖对方正在播的文件 */
function stagingPath(host: Host): string {
  return join(host.tmpDir, `say-${host.pid}.wav`);
}

/** 残留的临时文件只是脏，清理失败不该盖掉真正的失败原因 */
async function discard(host: Host, path: string): Promise<void> {
  try {
    await host.removeFile(path);
  } catch {
    // 目标目录已经出问题了，再多一个删不掉的文件不改变结论
  }
}

async function deliverPcm(host: Host, out: Extract<AudioOut, { type: "pcm" }>, delivery: Delivery): Promise<DeliveryResult> {
  const bytes = encodeWav(out.samples, out.sampleRate);
  const { target, temp } = delivery;
  if (target !== null && temp !== null) {
    try {
      await host.writeFile(temp, bytes);
    } catch (error) {
      // 写失败同样要清临时名：writeFile 先 O_CREAT|O_TRUNC 建文件再写，
      // ENOSPC 这类抛在写入阶段的错误已经留下半截文件，而每次失败都是新 PID 新名字，会持续累积
      await discard(host, temp);
      return { delivered: false, error: `写入 ${target} 失败：${messageOf(error)}` };
    }
    return renameInto(host, temp, target);
  }
  const staging = stagingPath(host);
  try {
    await host.writeFile(staging, bytes);
    await playFile(host, staging);
    return DELIVERED;
  } catch (error) {
    return { delivered: false, error: messageOf(error) };
  } finally {
    await discard(host, staging);
  }
}

/**
 * 临时名 → 目标名的原子改名：读者要么看到旧文件要么看到完整新文件，不会读到半截。
 * 改名失败要顺手清掉临时名，否则反复失败的调用会在目标目录攒出一堆孤儿 `.tmp`。
 */
async function renameInto(host: Host, temp: string, target: string): Promise<DeliveryResult> {
  try {
    await host.renameFile(temp, target);
    return DELIVERED;
  } catch (error) {
    await discard(host, temp);
    return { delivered: false, error: `写入 ${target} 失败：${messageOf(error)}` };
  }
}

async function deliver(host: Host, out: AudioOut, delivery: Delivery): Promise<DeliveryResult> {
  if (out.type === "pcm") return deliverPcm(host, out, delivery);
  const { target } = delivery;
  if (out.type === "device" || target === null || out.path === target) return DELIVERED;
  return renameInto(host, out.path, target);
}

type Attempt = { ok: true; out: AudioOut } | { ok: false; reason: string };

/** 回退原因行的固定前缀，脚本可以据此稳定 grep 到「这次不是主引擎出的声」 */
const FALLBACK_PREFIX = "fallback: ";

async function speakWith(engine: EngineAdapter, text: string, opts: SpeakOptions): Promise<Attempt> {
  try {
    return { ok: true, out: await engine.speak(text, opts) };
  } catch (error) {
    return { ok: false, reason: `引擎 "${engine.name}" 合成失败：${messageOf(error)}` };
  }
}

async function attemptSpeak(
  engine: EngineAdapter | undefined,
  engineName: string,
  registry: EngineRegistry,
  text: string,
  opts: SpeakOptions,
): Promise<Attempt> {
  if (engine === undefined) {
    return {
      ok: false,
      reason: `未登记的引擎 "${engineName}"（已登记：${registry.names().join(", ") || "无"}）`,
    };
  }
  const availability = await engine.isAvailable(opts.voice);
  if (!availability.ok) {
    return { ok: false, reason: `引擎 "${engine.name}" 不可用：${availability.reason}` };
  }
  return speakWith(engine, text, opts);
}

/**
 * 回退到系统嗓。say 的可用性下限是「总能出声」：神经引擎缺资产、产出静音或直接抛错，
 * 都不该让调用方哑掉。回退成功即算出过声，因此 exit 0，只留一行带固定前缀的原因。
 * 不回退到自己：同一次失败重试一遍只会多一行原因，不会多一分出声机会。
 */
async function recover(
  deps: RunDeps,
  reason: string,
  primary: EngineAdapter | undefined,
  config: ResolvedConfig,
  text: string,
  opts: SpeakOptions,
): Promise<Attempt> {
  if (config.fallback === "off") return { ok: false, reason };
  const backup = deps.registry.get(SYSTEM_ENGINE);
  if (backup === undefined) {
    return { ok: false, reason: `${reason}；回退引擎 "${SYSTEM_ENGINE}" 未登记` };
  }
  if (primary !== undefined && backup.name === primary.name) return { ok: false, reason };
  const availability = await backup.isAvailable(opts.voice);
  if (!availability.ok) {
    return { ok: false, reason: `${reason}；回退引擎 "${backup.name}" 也不可用：${availability.reason}` };
  }
  deps.host.writeStderr(`say: ${FALLBACK_PREFIX}${reason}\n`);
  return speakWith(backup, text, opts);
}

async function deliverAndExit(host: Host, out: AudioOut, target: string | null, temp: string | null): Promise<number> {
  const delivery = await deliver(host, out, { target, temp });
  if (!delivery.delivered) return fail(host, delivery.error ?? "产物交付失败");
  return EXIT_OK;
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

  const route = routeEngine(config, deps.registry);
  const target = request.output;
  const temp = target === null ? null : `${target}.${host.pid}.tmp`;
  const opts: SpeakOptions = { voice: route.voice, rateWpm: config.rateWpm, output: temp };

  const attempt = await attemptSpeak(route.engine, config.engine, deps.registry, source.text, opts);
  if (attempt.ok) return deliverAndExit(host, attempt.out, target, temp);

  const recovered = await recover(deps, attempt.reason, route.engine, config, source.text, opts);
  if (!recovered.ok) return fail(host, recovered.reason);
  return deliverAndExit(host, recovered.out, target, temp);
}
