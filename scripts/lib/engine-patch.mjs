// FireRedTTS3 机械 patch 幂等应用器（engine-v2 S1）：读 manifest patches 清单做精确字符串替换。
// 幂等语义：find 在 → 替换并计数；replace 已在 → skip；两者都不在 → drifted（上游漂移，报错不硬改）。
// ensureImport：设备行 patch 用了 os.environ，上游文件若无 import os 则在首行 import 块后补入。
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * 对单文件内容应用全部匹配该文件的 patch 条目。
 * @returns {{action:"applied"|"skipped"|"drifted"|"absent", changed:number, patches:Object[]}}
 */
export function applyPatchEntries(content, entries) {
  let out = content;
  let changed = 0;
  const results = [];
  for (const p of entries) {
    if (out.includes(p.replace)) {
      results.push({ file: p.file, action: "skipped", why: "replace 已在（幂等重放）" });
      continue;
    }
    if (!out.includes(p.find)) {
      results.push({ file: p.file, action: "drifted", why: "find 不在：上游源码已漂移，需人工核对 patch 清单" });
      continue;
    }
    out = out.replaceAll(p.find, p.replace);
    if (p.ensureImport && !new RegExp(`^import ${p.ensureImport}\\b`, "m").test(out)) {
      // import os 缺失：插到首个 import 行之前（Python 语法要求 import 在模块顶层，文件头插入最稳）
      out = `import ${p.ensureImport}\n${out}`;
    }
    changed++;
    results.push({ file: p.file, action: "applied", why: p.why ?? "" });
  }
  // 漂移优先暴露：有 drifted 即整体 drifted（调用方要人工核对清单），其余按 changed 分 applied/skipped
  const hasDrift = results.some((r) => r.action === "drifted");
  const action = hasDrift ? "drifted" : changed > 0 ? "applied" : "skipped";
  return { action, changed, patches: results, content: out };
}

/**
 * 对已克隆引擎仓应用 patch 清单（落盘版）。
 * @param {object} manifest ENGINES 条目
 * @param {string} engineDir 引擎 say-lab 目录
 * @param {{readFileSync?:Function, writeFileSync?:Function, existsSync?:Function}} io 可注入（单测假 fs）
 */
export function applyPatches(manifest, engineDir, io = {}) {
  const read = io.readFileSync ?? readFileSync;
  const write = io.writeFileSync ?? writeFileSync;
  const exists = io.existsSync ?? (() => true);
  // 按文件聚合：同一文件多条 patch（如 base.py 设备行 + config 字典）一次读写
  const byFile = new Map();
  for (const p of manifest.patches) {
    if (!byFile.has(p.file)) byFile.set(p.file, []);
    byFile.get(p.file).push(p);
  }
  const fileResults = [];
  let totalChanged = 0;
  for (const [rel, entries] of byFile) {
    const abs = path.join(engineDir, manifest.repoDir, rel);
    if (!exists(abs)) {
      fileResults.push({ file: rel, action: "absent", why: "仓库未克隆或文件缺失" });
      continue;
    }
    const r = applyPatchEntries(read(abs, "utf8"), entries);
    if (r.changed > 0) write(abs, r.content);
    totalChanged += r.changed;
    // 聚合 action 与 entries 级判定同语义：drift 优先暴露，不因同文件另一条 applied 而吞掉
    const fileAction = r.patches.some((p) => p.action === "drifted") ? "drifted" : r.changed > 0 ? "applied" : "skipped";
    fileResults.push({ file: rel, action: fileAction, changed: r.changed, patches: r.patches });
  }
  return { ok: fileResults.every((f) => f.action !== "drifted" && f.action !== "absent"), changed: totalChanged, files: fileResults };
}
