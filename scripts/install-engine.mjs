#!/usr/bin/env node
// 四引擎安装器（engine-v2 S1）：uv venv 依赖面 + 权重下载（ModelScope/hf-mirror fallback + sha256）+ FireRed patch，全部幂等可重跑。
// 子命令：status [--json]（安装状态查询）/ install <engine>（幂等安装）/ patch firered（只跑 patch）。
// 幂等语义：venv 在则跳过创建、权重 sha256 已对则跳过下载、patch 已应用则跳过——重复执行只补缺失部分。
// 代理透传 = 子进程继承本进程 env；网络约定（上海）：HF_ENDPOINT 镜像 fallback 由通道表承载，代理 env 交给用户 shell。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ENGINES, ENGINE_IDS, sayLabRoot, engineDir, UV_INDEX } from "./lib/engine-manifest.mjs";
import { downloadAsset, sizeMatches } from "./lib/engine-channels.mjs";
import { assessAll } from "./lib/engine-status.mjs";
import { applyPatches } from "./lib/engine-patch.mjs";

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const verifyOnly = args.includes("--verify");
const cmd = args.find((a) => !a.startsWith("-")) ?? "status";

function fail(msg) {
  console.error(`install-engine: ${msg}`);
  process.exit(1);
}

function usage() {
  console.log(`用法: install-engine.mjs <status|install|patch> [engine] [--json] [--verify]
  status [--json]       四引擎安装状态（--verify 时缺项导致 exit 1）
  install <engine>      幂等安装：克隆仓库 + uv venv 依赖 + 权重下载 + patch（engine = ${ENGINE_IDS.join("|")}|all）
  patch <engine>        只应用 patch 清单（当前仅 firered 有）`);
}

/** 克隆引擎仓：浅克隆一次成功；目录在则跳过（不 pull——安装器锁定调研实证的 commit 附近状态，升级是显式动作） */
function ensureRepo(manifest, dir) {
  const dest = path.join(dir, manifest.repoDir);
  if (existsSync(dest)) return { action: "skipped", dest };
  mkdirSync(dir, { recursive: true });
  const r = spawnSync("git", ["clone", "--depth", "1", manifest.repo, dest], { encoding: "utf8", timeout: 30 * 60 * 1000 });
  if (r.status !== 0) fail(`克隆 ${manifest.repo} 失败: ${(r.stderr ?? "").slice(-200)}`);
  return { action: "cloned", dest };
}

/** uv 命令公共 env：PyPI 镜像（国内直连挂死，报告实证）+ 代理透传（继承即可，不显式改写） */
function uvEnv(extra = {}) {
  return { ...process.env, UV_DEFAULT_INDEX: UV_INDEX, ...extra };
}

/** 构建依赖面：每引擎按 manifest.deps 分派（gptsovits/voxcpm/firered 走 uv pip，indextts 走 uv sync） */
function ensureDeps(manifest, dir) {
  const py = venvPythonPath(dir, manifest);
  if (py) return { action: "skipped", venv: py };
  const repoCwd = path.join(dir, manifest.repoDir);
  const venvDir = path.join(dir, "venv");
  if (!manifest.deps.steps.some((s) => s.sync)) {
    const r = spawnSync("uv", ["venv", "--python", manifest.python, venvDir], { encoding: "utf8", timeout: 10 * 60 * 1000 });
    if (r.status !== 0) fail(`uv venv (${manifest.python}) 失败: ${(r.stderr ?? "").slice(-200)}`);
  }
  // firered：requirements 剔除 CUDA-only 与零引用包后写临时清单（上游 requirements 在 Mac 不可装，报告安装面节）
  if (manifest.deps.filterRequirements) {
    const raw = readFileSync(path.join(repoCwd, "requirements.txt"), "utf8");
    const kept = raw.split("\n").filter((line) => {
      const t = line.trim().toLowerCase();
      if (!t || t.startsWith("#") || t.startsWith("-")) return true;
      const name = t.split(/[<>=!\s;[]/)[0];
      return !manifest.deps.filterRequirements.exclude.some((pkg) => name === pkg.toLowerCase());
    });
    writeFileSync(path.join(repoCwd, "requirements.min.txt"), kept.join("\n"));
  }
  for (const step of manifest.deps.steps) {
    const cwd = step.cwd === "repo" ? repoCwd : dir;
    const args = [...step.cmd];
    if (step.index && !step.sync) args.push("--python", venvDir);
    const r = spawnSync(args[0], args.slice(1), { cwd, env: uvEnv(), encoding: "utf8", timeout: 2 * 60 * 60 * 1000 });
    // uv pip install 尾接管道吞退出码的前科（gptsovits 票），此处直接 spawn 不经管道，status!==0 即失败
    if (r.status !== 0) fail(`依赖安装失败 (${args.join(" ")}): ${(r.stderr ?? r.stdout ?? "").slice(-300)}`);
  }
  linkVenvPackageAssets(manifest, dir);
  return { action: "installed", venv: venvPythonPath(dir, manifest) };
}

/** 权重条目声明 linkIntoVenvPackage 的（open_jtalk 字典）：解压产物复制进 venv 包目录（engineDir 产物保留——status 判据与 .install-ok 都锚在原位） */
function linkVenvPackageAssets(manifest, dir) {
  const py = venvPythonPath(dir, manifest);
  if (!py) return;
  const sitePackages = path.join(path.dirname(py), "..", "lib", `python${manifest.python}`, "site-packages");
  for (const w of manifest.weights) {
    if (!w.linkIntoVenvPackage) continue;
    const extracted = path.join(dir, w.file);
    if (!existsSync(extracted)) continue;
    const target = path.join(sitePackages, w.linkIntoVenvPackage, path.basename(w.file));
    if (existsSync(target)) continue; // 幂等：venv 里已有（上轮拷过）不再动
    if (!existsSync(path.join(sitePackages, w.linkIntoVenvPackage))) continue; // 依赖未装好，跳过待下轮
    const r = spawnSync("cp", ["-R", extracted, target], { encoding: "utf8" });
    if (r.status !== 0) fail(`字典拷入 venv 失败 (${w.file}): ${(r.stderr ?? "").slice(-200)}`);
  }
}

function venvPythonPath(dir, manifest) {
  for (const rel of ["venv/bin/python", ".venv/bin/python", path.join(manifest.repoDir, ".venv/bin/python")]) {
    if (existsSync(path.join(dir, rel))) return path.join(dir, rel);
  }
  return null;
}

/** 单权重资产下载落位（幂等：size+sha256 已对则跳过）；archive 形态解压后删包留产物目录 + .install-ok 完成标记 */
async function ensureWeight(dir, w) {
  const dest = path.join(dir, w.file);
  if (!w.archive && sizeMatches(dest, w.size)) {
    return { action: "verified-existing" };
  }
  // archive 幂等标记：.install-ok 在 = 解压全流程此前完整走完（防下载完但解包中断的半吊目录被误判就绪）
  if (w.archive && existsSync(path.join(dest, ".install-ok"))) {
    return { action: "verified-existing" };
  }
  const staging = path.join(dir, ".staging", `${path.basename(w.file)}.download`);
  const r = await downloadAsset(w, staging, { log: (e) => console.error(`  [${w.file}] ${e.phase} ${e.channel ?? ""} ${e.ok === false ? "FAIL" : "ok"} ${e.stderrTail ?? ""}`) });
  if (!r.ok) return { action: "download-failed", file: w.file };
  if (w.archive) {
    rmSync(dest, { recursive: true, force: true }); // 半吊解压产物清掉重来
    mkdirSync(dest, { recursive: true });
    // zip/tar 判据锚在源 URL 原始扩展名（staging 名恒 .download，锚它会成死分支；gnutar 对 zip 不自动探测）
    const isZip = w.sources[0].url.split("?")[0].endsWith(".zip");
    const tool = isZip ? "unzip" : "tar";
    const targs = isZip ? ["-q", "-o", staging, "-d", dest] : ["xzf", staging, "-C", dest];
    const x = spawnSync(tool, targs, { encoding: "utf8", timeout: 30 * 60 * 1000 });
    if (x.status !== 0) return { action: "extract-failed", file: w.file, stderr: (x.stderr ?? "").slice(-200) };
    if (w.archive.strip > 0) stripDir(dest, w.archive.strip);
    writeFileSync(path.join(dest, ".install-ok"), new Date().toISOString());
    rmSync(staging, { force: true });
  } else {
    mkdirSync(path.dirname(dest), { recursive: true });
    if (existsSync(dest)) rmSync(dest, { force: true });
    spawnSync("mv", [staging, dest], { encoding: "utf8" });
  }
  return { action: "installed", channel: r.channel, verified: r.verified };
}

/** zip 解压后的顶层目录折叠（strip=1：pretrained_models/xxx → xxx） */
function stripDir(dest, levels) {
  let cur = dest;
  for (let i = 0; i < levels; i++) {
    const entries = readdirSafe(cur);
    if (entries.length !== 1) return;
    cur = path.join(cur, entries[0]);
  }
  if (cur === dest) return;
  spawnSync("bash", ["-c", `shopt -s dotglob; mv "${cur}"/* "${dest}"/ && rmdir "${cur}"`], { encoding: "utf8" });
}

function readdirSafe(d) {
  try {
    return readdirNoDots(d);
  } catch {
    return [];
  }
}

function readdirNoDots(d) {
  return readdirSync(d).filter((n) => n !== ".DS_Store");
}

async function cmdInstall(engineId) {
  const targets = engineId === "all" ? ENGINE_IDS : [engineId];
  for (const id of targets) {
    const manifest = ENGINES[id];
    if (!manifest) fail(`未知引擎 ${id}（可选: ${ENGINE_IDS.join("|")}|all）`);
    const dir = engineDir(id);
    console.error(`== ${id} ==`);
    ensureRepo(manifest, dir);
    console.error(`  仓库: ok`);
    const deps = ensureDeps(manifest, dir);
    console.error(`  依赖: ${deps.action}`);
    for (const w of manifest.weights) {
      if (w.tier === "auto") continue; // 首跑自拉依赖不主动下载（20GB 级大件按需）
      const r = await ensureWeight(dir, w);
      console.error(`  权重 ${w.file}: ${r.action}${r.channel ? ` (${r.channel}/${r.verified})` : ""}`);
      if (r.action === "download-failed" || r.action === "extract-failed") process.exitCode = 1;
    }
    linkVenvPackageAssets(manifest, dir);
    if (manifest.patches.length > 0) {
      const p = applyPatches(manifest, dir);
      console.error(`  patch: ${p.changed > 0 ? `applied ${p.changed}` : p.ok ? "already" : "DRIFT"}`);
      if (!p.ok) process.exitCode = 1;
    }
  }
}

function cmdStatus() {
  const lab = sayLabRoot();
  const engines = assessAll(lab);
  if (jsonOut) {
    console.log(JSON.stringify({ labRoot: lab, engines }, null, 2));
  } else {
    for (const e of engines) {
      console.log(`${e.engine.padEnd(10)} ${e.status.padEnd(8)} venv=${e.venv}${e.patchStatus ? ` patch=${e.patchStatus}` : ""}${e.missing.length ? ` 缺:${e.missing.length}` : ""}${e.autoPending.length ? ` auto待:${e.autoPending.length}` : ""}`);
    }
  }
  if (verifyOnly && engines.some((e) => e.status !== "ready")) process.exitCode = 1;
}

function cmdPatch(engineId) {
  const manifest = ENGINES[engineId];
  if (!manifest) fail(`未知引擎 ${engineId}`);
  if (manifest.patches.length === 0) fail(`引擎 ${engineId} 无 patch 清单`);
  const dir = engineDir(engineId);
  const p = applyPatches(manifest, dir);
  if (jsonOut) console.log(JSON.stringify(p, null, 2));
  else for (const f of p.files) console.log(`${f.file}: ${f.action}${f.changed ? ` (${f.changed})` : ""}`);
  if (!p.ok) process.exitCode = 1;
}

if (cmd === "status") cmdStatus();
else if (cmd === "install") cmdInstall(args[args.indexOf("install") + 1] ?? "");
else if (cmd === "patch") cmdPatch(args[args.indexOf("patch") + 1] ?? "");
else usage();
