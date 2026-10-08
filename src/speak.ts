import type { CliRequest } from "./cli.ts";
import { parseArgv } from "./cli.ts";
import { parseConfigFile, resolveConfig } from "./config.ts";
import { startTiming, stagingPath, type Delivery } from "./delivery.ts";
import type { RunDeps } from "./deps.ts";
import { runEngineCommand } from "./engines-command.ts";
import { runDaemonCommand } from "./daemon-command.ts";
import { routeEngine } from "./engines/index.ts";
import { messageOf } from "./errors.ts";
import type { Host } from "./host.ts";
import { detectLocale } from "./locale.ts";
import { chunkText, normalizeText } from "./normalize.ts";
import { speakChunked, speakOnce, type SpeakContext } from "./pipeline.ts";
import { EXIT_OK, EXIT_USAGE, fail, writeDebug } from "./report.ts";
import type { ConfigFile, SpeakOptions } from "./types.ts";

type TextSource = { ok: true; text: string } | { ok: false; error: string };

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
async function resolveText(request: Extract<CliRequest, { kind: "speak" }>, host: Host): Promise<TextSource> {
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

/** 配置坏了不该让命令瘫痪：降级为默认值，把原因留在 stderr 上 */
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

/**
 * 编排：解析 → 取正文 → 配置三层合并 → 规范化与分块 → 选引擎 → 合成 → 交付。
 * 退出码语义遵循「产生过声音或产物即 0」：只有全程无声无文件才非零。
 */
export async function run(argv: readonly string[], deps: RunDeps): Promise<number> {
  const { host } = deps;
  const request = parseArgv(argv);

  if (request.kind === "engine") return runEngineCommand(deps, request);
  if (request.kind === "daemon") return runDaemonCommand(deps, request);
  if (request.kind === "passthrough") return passthrough(deps, request.argv);
  if (request.kind === "usage-error") {
    host.writeStderr(`say: ${request.message}\n`);
    return EXIT_USAGE;
  }

  const source = await resolveText(request, host);
  if (!source.ok) return fail(host, source.error);
  const text = normalizeText(source.text);
  // 引擎对空文本会抛错而非产出静音，与 macOS `say ""` 的静默成功对齐只能在这一层短路
  if (text.length === 0) return EXIT_OK;

  const loaded = await loadConfigFile(host, deps.paths.configFile);
  for (const warning of loaded.warnings) host.writeStderr(`say: ${warning}\n`);

  // 两段解析：第一段不带 locale 判定关键字是否在场（含预设层），在场才付 locale 探测的子进程成本并重解析。
  // 门控取自解析器自身的 needsLocale 而非调用方扫描层源——后者与解析器是两份真源，必然漂移
  const flags = { voice: request.voice, rateWpm: request.rateWpm, preset: request.preset, engine: request.engine };
  let resolution = resolveConfig({ env: host.env, file: loaded.file, flags });
  if (resolution.needsLocale) {
    resolution = resolveConfig({ env: host.env, file: loaded.file, flags, locale: await detectLocale(host) });
  }
  for (const warning of resolution.warnings) host.writeStderr(`say: ${warning}\n`);
  const config = resolution.config;

  const route = await routeEngine(config, deps.registry);
  const engine = route.engine;
  // daemon= 段按路由到的引擎查形态：回退到系统嗓后 outcome.engineName 会变成 system，
  // 而形态记在被尝试的引擎名下，渲染面凭此才看得见「走过 daemon 层但降级了」
  const routedEngine = engine?.name ?? config.engine;
  const target = request.output;
  const temp = target === null ? null : `${target}.${host.pid}.tmp`;
  const opts: SpeakOptions = { voice: route.voice, rateWpm: config.rateWpm, output: temp };
  // 分块只给能把裸样本交回编排层的引擎：其余引擎自己写盘或直推声卡，块与块之间无从拼接
  const chunks = engine !== undefined && engine.chunkable ? chunkText(text) : [text];
  const timing = startTiming(host);
  const delivery: Delivery = { target, temp, staging: stagingPath(host, chunks.length > 1 ? 0 : null) };
  const ctx: SpeakContext = { deps, config, opts, delivery, timing, fullText: text };

  // 出声卡模式下流式引擎单块也走编排路径：引擎内流式的开口收益恰恰在单句场景最大
  const streamEligible = engine !== undefined && engine.speakStreaming !== undefined && target === null;
  const outcome =
    engine !== undefined && (chunks.length > 1 || streamEligible)
      ? await speakChunked(ctx, engine, chunks)
      : await speakOnce(ctx, engine, chunks[0] ?? text);

  writeDebug(host, config, outcome, opts.voice, chunks.length, timing, routedEngine);
  return outcome.code;
}
