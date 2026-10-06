// 引擎安装状态评估（engine-v2 S1）：纯函数读文件系统，不打网络不装东西，是 status --json 与 --verify 的共同裁决点。
// 三态：missing（venv 缺且主权重有缺，视为从未装过）/ partial（主权重缺）/ ready（venv + 主权重 + patch 齐）；
// tier=auto 的首跑自拉依赖缺失只进 autoPending 提示，不拉低状态（引擎侧 fallback 链实测可用，报告实证）。
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ENGINES } from "./engine-manifest.mjs";

/** venv 解释器存在即视为依赖面就绪（uv venv 落 venv/.venv，uv sync 落仓库内 .venv；三形态都认） */
export function venvPython(engineDir, manifest, exists = existsSync) {
  const candidates = [
    path.join(engineDir, "venv", "bin", "python"),
    path.join(engineDir, ".venv", "bin", "python"),
    path.join(engineDir, manifest.repoDir, ".venv", "bin", "python"),
  ];
  return candidates.find((p) => exists(p)) ?? null;
}

/**
 * 单资产就绪判据：文件形态直接 stat；archive（解压目录）形态须 .install-ok 完成标记在位——
 * 目录存在只说明解压开始过，中断残留的半吊目录不能算就绪（marker 由安装器解压全流程走完才写）。
 */
export function assetPresent(absPath, isArchive = false, fs = {}) {
  const stat = fs.statSync ?? statSync;
  const exists = fs.existsSync ?? existsSync;
  try {
    const s = stat(absPath);
    if (isArchive) return s.isDirectory() && exists(`${absPath}/.install-ok`);
    return s.isFile();
  } catch {
    return false;
  }
}

/**
 * 评估单引擎安装状态。
 * @param {object} manifest ENGINES 条目
 * @param {string} engineDir 该引擎的 say-lab 落位目录
 * @param {{existsSync?:Function, statSync?:Function, readFileSync?:Function}} fs 可注入的 fs 面（单测用假树）
 * @returns {{engine:string, status:"ready"|"partial"|"missing", venv:"ok"|"missing",
 *   missing:string[], autoPending:string[], patchStatus:"applied"|"pending"|"partial"|"drifted"|null}}
 */
export function assessEngine(manifest, engineDir, fs = {}) {
  const exists = fs.existsSync ?? existsSync;
  const stat = fs.statSync ?? statSync;
  const venv = venvPython(engineDir, manifest, exists);
  const missing = [];
  const autoPending = [];
  for (const w of manifest.weights) {
    if (assetPresent(path.join(engineDir, w.file), Boolean(w.archive), { statSync: stat, existsSync: exists })) continue;
    (w.tier === "auto" ? autoPending : missing).push(w.file);
  }
  const requiredMissing = missing.length > 0;
  const patchStatus = manifest.patches.length > 0 ? assessPatches(manifest, engineDir, fs) : null;
  // ready 三面齐：venv（解释器）+ 主权重（资产）+ patch（上游适配）——任一面缺即 partial，venv 缺且权重缺是 missing
  const patchOk = patchStatus === null || patchStatus === "applied";
  const status = requiredMissing ? (!venv ? "missing" : "partial") : venv && patchOk ? "ready" : "partial";
  return {
    engine: manifest.id,
    status,
    venv: venv ? "ok" : "missing",
    missing,
    autoPending,
    patchStatus,
  };
}

/** patch 状态：全应用 = applied，全未动 = pending（含上游未克隆 absent），有换过/有没换 = partial，find 与 replace 都不匹配 = drifted（上游漂移信号） */
export function assessPatches(manifest, engineDir, fs = {}) {
  const exists = fs.existsSync ?? existsSync;
  const read = fs.readFileSync ?? readFileSync;
  const states = manifest.patches.map((p) => {
    const file = path.join(engineDir, manifest.repoDir, p.file);
    if (!exists(file)) return "absent";
    const content = read(file, "utf8");
    if (content.includes(p.replace)) return "applied";
    if (content.includes(p.find)) return "pending";
    return "drifted";
  });
  if (states.every((s) => s === "applied")) return "applied";
  if (states.includes("drifted")) return "drifted";
  if (states.every((s) => s === "pending" || s === "absent")) return "pending";
  return "partial";
}

/** 四引擎全量评估（status 子命令的数据面）；pathJoin 参数化让单测不用造真实目录树也能换根 */
export function assessAll(labRoot) {
  return Object.values(ENGINES).map((m) => assessEngine(m, path.join(labRoot, m.id)));
}
