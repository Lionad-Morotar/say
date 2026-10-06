// 状态评估单测：三态判定、auto 依赖不拉低状态、patch 四态，全部注入假 fs 不触真实 say-lab。
import test from "node:test";
import assert from "node:assert/strict";
import { assessEngine, assessPatches, venvPython, assetPresent } from "./engine-status.mjs";
import { ENGINES } from "./engine-manifest.mjs";

/** 假 fs：paths 集合里存在的路径即存在（stat/read 按需给内容） */
function fakeFs(paths, contents = {}) {
  const set = new Set(paths);
  return {
    existsSync: (p) => set.has(p),
    statSync: (p) => {
      if (!set.has(p)) throw new Error("ENOENT");
      return { isFile: () => !contents[p]?.dir, isDirectory: () => Boolean(contents[p]?.dir) };
    },
    readFileSync: (p) => {
      if (!set.has(p)) throw new Error("ENOENT");
      return contents[p]?.content ?? "";
    },
  };
}

const M = ENGINES.voxcpm; // 无 patch、权重全文件形态，作通用样本
const D = "/lab/voxcpm";

test("全空目录 = missing（venv 缺 + 主权重缺）", () => {
  const r = assessEngine(M, D, fakeFs([]));
  assert.equal(r.status, "missing");
  assert.equal(r.venv, "missing");
  assert.equal(r.missing.length, M.weights.length);
});

test("venv 在 + 权重齐 = ready", () => {
  const paths = [`${D}/venv/bin/python`, ...M.weights.map((w) => `${D}/${w.file}`)];
  const r = assessEngine(M, D, fakeFs(paths));
  assert.equal(r.status, "ready");
  assert.equal(r.venv, "ok");
  assert.deepEqual(r.missing, []);
});

test("venv 在但权重缺 = partial（装了一半）", () => {
  const paths = [`${D}/venv/bin/python`, `${D}/${M.weights[0].file}`];
  const r = assessEngine(M, D, fakeFs(paths));
  assert.equal(r.status, "partial");
  assert.equal(r.missing.length, M.weights.length - 1);
});

test("venv 缺但权重全在 = partial（权重在盘但依赖面未建，跑不起来）", () => {
  const paths = M.weights.map((w) => `${D}/${w.file}`);
  const r = assessEngine(M, D, fakeFs(paths));
  assert.equal(r.status, "partial");
});

test("auto 层依赖缺失只进 autoPending，不拉低 ready", () => {
  const m = ENGINES.indextts;
  const d = "/lab/indextts";
  const main = m.weights.filter((w) => w.tier !== "auto").map((w) => `${d}/${w.file}`);
  const paths = [`${d}/index-tts/.venv/bin/python`, ...main]; // uv sync 形态 venv
  const r = assessEngine(m, d, fakeFs(paths));
  assert.equal(r.status, "ready", "auto 缺失不判 partial");
  assert.equal(r.autoPending.length, m.weights.filter((w) => w.tier === "auto").length);
});

test("archive 资产以 .install-ok 完成标记为就绪判据（防解压中断残目录假就绪）", () => {
  const m = ENGINES.gptsovits;
  const d = "/lab/gptsovits";
  const zipAsset = m.weights.find((w) => w.file.endsWith("pretrained_models"));
  assert.ok(zipAsset.archive, "样本确为 archive 条目");
  const dirStat = { statSync: (p) => p.endsWith(zipAsset.file) ? { isFile: () => false, isDirectory: () => true } : { isFile: () => true, isDirectory: () => false }, existsSync: () => false };
  const withMarker = { statSync: dirStat.statSync, existsSync: (p) => p.endsWith(".install-ok") };
  assert.equal(assetPresent(`${d}/${zipAsset.file}`, true, dirStat), false, "目录在但无 marker = 未就绪");
  assert.equal(assetPresent(`${d}/${zipAsset.file}`, true, withMarker), true, "marker 在 = 就绪");
  assert.equal(assetPresent(`${d}/x.bin`, false, withMarker), true, "文件形态不查 marker");
});

test("venvPython 认三种落位（venv / .venv / 仓库内 .venv）", () => {
  assert.equal(venvPython(D, M, fakeFs([`${D}/venv/bin/python`]).existsSync), `${D}/venv/bin/python`);
  assert.equal(venvPython(D, M, fakeFs([`${D}/.venv/bin/python`]).existsSync), `${D}/.venv/bin/python`);
  const m = ENGINES.indextts;
  assert.equal(venvPython("/lab/i", m, fakeFs([`/lab/i/index-tts/.venv/bin/python`]).existsSync), "/lab/i/index-tts/.venv/bin/python");
});

test("assessPatches：全应用 applied / 全未动 pending / 部分应用 partial / 上游漂移 drifted", () => {
  const m = ENGINES.firered;
  const d = "/lab/firered";
  const repo = `${d}/FireRedTTS3`;
  const src = (n) => `${repo}/${n}`;

  // applied：全清单文件都含 replace（base.py 两条 patch 内容累加，同文件多 patch）
  const allPaths = m.patches.map((p) => src(p.file));
  const contentsOf = (pick) => {
    const byFile = new Map();
    for (const p of m.patches) byFile.set(p.file, `${byFile.get(p.file) ?? "import os\n"}${pick(p)}\n`);
    return byFile;
  };
  const mkFs = (pick) => {
    const byFile = contentsOf(pick);
    return fakeFs(allPaths, Object.fromEntries([...byFile].map(([f, content]) => [src(f), { content }])));
  };
  assert.equal(assessPatches(m, d, mkFs((p) => p.replace)), "applied");

  // pending：上游原样（find 在）
  assert.equal(assessPatches(m, d, mkFs((p) => p.find)), "pending");

  // partial：一部分 applied 一部分 pending（base.py 两条并存：0 applied + 3 pending 拼接，避免同 key 覆盖）
  const halfFs = fakeFs(allPaths, {
    [src(m.patches[0].file)]: { content: `${m.patches[0].replace}\n${m.patches[3].find}\n` },
    [src(m.patches[1].file)]: { content: m.patches[1].replace },
    [src(m.patches[2].file)]: { content: m.patches[2].find },
  });
  assert.equal(assessPatches(m, d, halfFs), "partial");

  // drifted：find 与 replace 都不在（上游改了行）
  const driftFs = fakeFs(allPaths, Object.fromEntries(m.patches.map((p) => [src(p.file), { content: "self.device = something_new()\n" }])));
  assert.equal(assessPatches(m, d, driftFs), "drifted");

  // 仓库未克隆 = pending（absent 视同未动）
  assert.equal(assessPatches(m, d, fakeFs([])), "pending");
});

test("无 patch 的引擎 patchStatus 为 null", () => {
  assert.equal(assessEngine(ENGINES.voxcpm, D, fakeFs([])).patchStatus, null);
});

test("patch 未应用拉低状态：权重与 venv 齐、patch pending = partial（不判 ready）", () => {
  const m = ENGINES.firered;
  const d = "/lab/firered";
  const repo = `${d}/FireRedTTS3`;
  // 资产面全就绪（archive 带 marker、文件全在、venv 在），但上游源码保持原样（find 在 = pending；同文件多 patch 内容累加）
  const paths = [`${d}/venv/bin/python`];
  const contents = {};
  for (const w of m.weights) {
    paths.push(`${d}/${w.file}`);
    if (w.archive) contents[`${d}/${w.file}/.install-ok`] = { dir: true };
  }
  for (const p of m.patches) {
    if (!paths.includes(`${repo}/${p.file}`)) paths.push(`${repo}/${p.file}`);
    contents[`${repo}/${p.file}`] = { content: `${contents[`${repo}/${p.file}`]?.content ?? ""}${p.find}\n` };
  }
  const r = assessEngine(m, d, fakeFs(paths, contents));
  assert.equal(r.patchStatus, "pending");
  assert.equal(r.status, "partial", "patch 未应用不判 ready");
});
