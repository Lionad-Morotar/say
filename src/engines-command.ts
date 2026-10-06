import { fileURLToPath } from "node:url";
import type { CliRequest } from "./cli.ts";
import { DEFAULT_ENGINE, parseConfigFile } from "./config.ts";
import type { RunDeps } from "./deps.ts";
import { EngineError, messageOf } from "./errors.ts";
import type { Host } from "./host.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "./report.ts";

/** install-engine status --json 输出的 engines[] 条目中本模块消费的面（S1 权威查询形态） */
export interface LabEngineStatus {
  engine: string;
  status: "ready" | "partial" | "missing";
}

/** 安装器脚本按仓库布局定位：src 内模块上跳两级即仓根 scripts/，bin/say 符号链接经 Node realpath 解析后同样成立 */
const INSTALL_ENGINE_SCRIPT = fileURLToPath(new URL("../../scripts/install-engine.mjs", import.meta.url));

/**
 * say-lab 四引擎安装状态经 install-engine status --json 查询（S1 钉定的权威面），
 * 不在 src 二次实现评估逻辑——状态判据演进时只有一个真源。
 * 查询失败（脚本缺失/退出非零/JSON 损坏）返回 null：ls 降级为只列已接线引擎，use 降级为只认已接线名。
 */
async function labStatus(host: Host): Promise<LabEngineStatus[] | null> {
  try {
    const outcome = await host.spawn(process.execPath, [INSTALL_ENGINE_SCRIPT, "status", "--json"]);
    if (outcome.exitCode !== 0) return null;
    const parsed: unknown = JSON.parse(outcome.stdout);
    if (typeof parsed !== "object" || parsed === null) return null;
    const engines = (parsed as { engines?: unknown }).engines;
    if (!Array.isArray(engines)) return null;
    return engines.filter(
      (entry): entry is LabEngineStatus =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as LabEngineStatus).engine === "string" &&
        typeof (entry as LabEngineStatus).status === "string",
    );
  } catch {
    return null;
  }
}

/** config 当前默认引擎的生效值：文件在且解析出 engine 字符串取之，否则落默认（与合成路径的读法同源） */
async function currentEngineOf(deps: RunDeps): Promise<string> {
  const configFile = deps.paths.configFile;
  if (!deps.host.fileExists(configFile)) return DEFAULT_ENGINE;
  try {
    const parsed = parseConfigFile(await deps.host.readFileText(configFile));
    if (parsed.ok && typeof parsed.value.engine === "string") return parsed.value.engine;
  } catch {
    // 读失败按默认引擎展示：ls 是只读命令，不该被配置损坏炸掉
  }
  return DEFAULT_ENGINE;
}

async function ls(deps: RunDeps): Promise<number> {
  const { host, registry } = deps;
  const wired = registry.names();
  const wiredSet = new Set(wired);
  const lab = await labStatus(host);
  const current = await currentEngineOf(deps);
  const lines: string[] = [];
  for (const name of wired) {
    lines.push(`${name === current ? "*" : " "} ${name.padEnd(12)} wired`);
  }
  if (lab === null) {
    host.writeStderr("say: say-lab 安装状态查询失败（install-engine status），仅列出已接线引擎\n");
  } else {
    for (const entry of lab) {
      if (wiredSet.has(entry.engine)) continue;
      lines.push(`${entry.engine === current ? "*" : " "} ${entry.engine.padEnd(12)} lab:${entry.status}`);
    }
  }
  host.writeStdout(lines.join("\n") + "\n");
  return EXIT_OK;
}

/**
 * 行级手术更新 config 的顶层 engine 键。整文件 round-trip 会丢注释与排版，用户配置的注释是资产；
 * TOML 顶层键必须出现在任何分节头之前，所以只认分节头之前的 engine 行（分节后的同名键属于子表，
 * 动了会写错语义），找不到就在文件顶部插入。
 * 抛错语义：config 读取失败或 TOML 损坏时抛出拒写——损坏原因需要用户先看见，不能被静默覆盖。
 */
async function writeConfigEngine(
  host: Host,
  configFile: string,
  engineName: string,
): Promise<"created" | "replaced" | "prepended"> {
  if (!host.fileExists(configFile)) {
    await atomicWrite(host, configFile, `engine = "${engineName}"\n`);
    return "created";
  }
  const text = await host.readFileText(configFile);
  const parsed = parseConfigFile(text);
  if (!parsed.ok) throw new EngineError(`config 解析失败，拒绝写入：${parsed.error}`);
  const lines = text.split("\n");
  let engineLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (/^\s*\[/.test(line)) break;
    if (/^\s*engine\s*=/.test(line)) {
      engineLine = i;
      break;
    }
  }
  if (engineLine >= 0) {
    lines[engineLine] = `engine = "${engineName}"`;
    await atomicWrite(host, configFile, lines.join("\n"));
    return "replaced";
  }
  await atomicWrite(host, configFile, `engine = "${engineName}"\n${text}`);
  return "prepended";
}

/** PID 临时名 + 原子改名（delivery 同款形态），config 目录可能尚不存在（首次 use） */
async function atomicWrite(host: Host, target: string, content: string): Promise<void> {
  const cut = target.lastIndexOf("/");
  if (cut > 0) await host.mkdir(target.slice(0, cut));
  const temp = `${target}.${host.pid}.tmp`;
  await host.writeFile(temp, new TextEncoder().encode(content));
  await host.renameFile(temp, target);
}

async function use(deps: RunDeps, name: string): Promise<number> {
  const { host } = deps;
  const wired = deps.registry.names();
  const lab = await labStatus(host);
  const labIds = (lab ?? []).map((entry) => entry.engine);
  const known = [...wired, ...labIds];
  if (!known.includes(name)) {
    host.writeStderr(`say: 未知的引擎 "${name}"（可用：${known.join(", ")}）\n`);
    return EXIT_USAGE;
  }
  const configFile = deps.paths.configFile;
  let outcome: "created" | "replaced" | "prepended";
  try {
    outcome = await writeConfigEngine(host, configFile, name);
  } catch (error) {
    host.writeStderr(`say: ${messageOf(error)}\n`);
    return EXIT_FAILURE;
  }
  host.writeStdout(`say: 默认引擎已设为 ${name}（${configFile}${outcome === "created" ? "，新建" : ""}）\n`);
  if (!wired.includes(name)) {
    host.writeStderr(`say: ${name} 尚未接线（引擎适配器未落地），出声将走回退链\n`);
  }
  return EXIT_OK;
}

/** engine 管理子命令编排：ls 列已接线引擎与 say-lab 安装状态，use 行级手术写 config 默认引擎 */
export async function runEngineCommand(deps: RunDeps, request: Extract<CliRequest, { kind: "engine" }>): Promise<number> {
  if (request.action === "ls") return ls(deps);
  return use(deps, request.name ?? "");
}
