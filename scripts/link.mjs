#!/usr/bin/env node
// PATH shadow 接线（s-deploy）：把 bin/say 接入目标 bin 目录，同名 shadow 系统 /usr/bin/say。
// 默认目标 ~/.local/bin（全局激活）；--bin-dir 覆盖（安装验证用临时目录）；--dry-run 只打印计划不落盘；
// --force 才允许覆盖已存在且非本 shim 的同名文件。幂等：已指向本 shim 的链接直接 skip。
// 真实接线动作落 docs/research/deploy/raw-log.jsonl（phase=link）；--dry-run 不入日志。
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import { DEFAULT_BIN_DIR, logEvent, SHIM_TARGET, SYSTEM_SAY } from "./lib/deploy-config.mjs";

const argv = process.argv.slice(2);
function argValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
}
const dryRun = argv.includes("--dry-run");
const force = argv.includes("--force");
const binDir = path.resolve(argValue("--bin-dir") ?? DEFAULT_BIN_DIR);
const linkPath = path.join(binDir, "say");

/** bin/say 是无扩展名 shebang 入口，依赖解析沿 realpath 落回仓库根，符号链接即可用，无需包装脚本 */
function planLines() {
  const lines = [
    `link:  ${linkPath} → ${SHIM_TARGET}`,
    `bin 目录：${binDir}${binDir === DEFAULT_BIN_DIR ? "（默认，全局激活；--bin-dir 可重定向验证）" : ""}`,
    `系统 say：${existsSync(SYSTEM_SAY) ? `${SYSTEM_SAY} 在位，同名 shadow 生效后仍可经该绝对路径直呼（长尾 flag 由透传兜底）` : "未检测到"}`,
  ];
  return lines;
}

function logLink(e) {
  if (!dryRun) logEvent({ phase: "link", engine: "link", proxy: null, ...e });
}

function main() {
  const exists = lstatSyncSafe(linkPath);
  let current = null;
  if (exists) {
    try {
      current = readlinkSync(linkPath);
    } catch {
      current = null; // 普通文件占位（非符号链接）
    }
  }
  if (exists && current !== null && path.resolve(path.dirname(linkPath), current) === SHIM_TARGET) {
    console.log(planLines().join("\n"));
    console.log(`skip（已就绪）：${linkPath} 已指向本 shim`);
    process.exit(0);
  }
  if (exists) {
    if (!force) {
      console.error(`已存在非本 shim 的 ${linkPath}，拒绝覆盖；确认后加 --force`);
      process.exit(1);
    }
    logLink({ cmd: `unlink ${linkPath}`, exit: 0 });
    unlinkSync(linkPath);
  }
  console.log(planLines().join("\n"));
  if (dryRun) {
    console.log("dry-run：未落盘");
    process.exit(0);
  }
  mkdirSync(binDir, { recursive: true });
  symlinkSync(SHIM_TARGET, linkPath);
  logLink({ cmd: `ln -s ${SHIM_TARGET} ${linkPath}`, exit: 0, outFile: linkPath });
  console.log(`done：${linkPath} → ${SHIM_TARGET}`);
}

function lstatSyncSafe(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

const r = spawnSync("node", ["--version"], { encoding: "utf8" });
if (r.status !== 0) {
  console.error("node 不可用：bin/say 是 Node 入口，请先安装 Node ≥ 22.18");
  process.exit(1);
}

main();