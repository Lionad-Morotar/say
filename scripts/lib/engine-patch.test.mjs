// patch 应用器单测：幂等三态（首应用/重放 skip/上游 drift）、ensureImport 补链、聚合落盘，注入假 io。
import test from "node:test";
import assert from "node:assert/strict";
import { applyPatchEntries, applyPatches } from "./engine-patch.mjs";
import { ENGINES } from "./engine-manifest.mjs";

const ENTRY = {
  file: "pkg/mod.py",
  find: "self.device = torch.device('cuda')",
  replace: "self.device = torch.device(os.environ.get('FIRERED_DEVICE', 'cuda'))",
};

test("首应用：find 替换为 replace，changed=1", () => {
  const r = applyPatchEntries("x = 1\nself.device = torch.device('cuda')\ny = 2\n", [ENTRY]);
  assert.equal(r.action, "applied");
  assert.equal(r.changed, 1);
  assert.ok(r.content.includes("os.environ.get('FIRERED_DEVICE', 'cuda')"));
  assert.ok(!r.content.includes("torch.device('cuda')"), "find 串被全部替换");
});

test("重放：replace 已在 → skip 不再改（幂等核心）", () => {
  const patched = "self.device = torch.device(os.environ.get('FIRERED_DEVICE', 'cuda'))\n";
  const r = applyPatchEntries(patched, [ENTRY]);
  assert.equal(r.action, "skipped");
  assert.equal(r.changed, 0);
  assert.equal(r.content, patched, "内容零改动");
});

test("上游漂移：find 与 replace 都不在 → drifted（报错不硬改）", () => {
  const r = applyPatchEntries("self.device = torch.device('tpu')\n", [ENTRY]);
  assert.equal(r.action, "drifted");
  assert.equal(r.changed, 0);
});

test("ensureImport：文件无 import os 时补在文件头，已有则不动", () => {
  const e = { ...ENTRY, ensureImport: "os" };
  const r1 = applyPatchEntries("import torch\nself.device = torch.device('cuda')\n", [e]);
  assert.ok(r1.content.startsWith("import os\n"), "补在文件头");
  const r2 = applyPatchEntries("import os\nimport torch\nself.device = torch.device('cuda')\n", [e]);
  assert.equal(r2.content.split("\n").filter((l) => l === "import os").length, 1, "不重复补");
});

test("同内容多 patch：逐条独立判定，部分漂移整体 drifted", () => {
  const good = { file: "a.py", find: "A1", replace: "A2" };
  const drift = { file: "a.py", find: "B1", replace: "B2" };
  const r = applyPatchEntries("A1\nXXX\n", [good, drift]);
  assert.equal(r.changed, 1);
  assert.equal(r.action, "drifted");
  assert.equal(r.patches.filter((p) => p.action === "drifted").length, 1);
});

test("applyPatches 落盘版：按文件聚合一次读写，写回带 replace 内容", () => {
  const m = ENGINES.firered;
  const files = new Map();
  for (const p of m.patches) files.set(p.file, `${files.get(p.file) ?? "import torch\n"}${p.find}\n`);
  const io = {
    existsSync: (f) => [...files.keys()].some((k) => f.endsWith(k)),
    readFileSync: (f) => files.get([...files.keys()].find((k) => f.endsWith(k))),
    writeFileSync: (f, c) => { files.set([...files.keys()].find((k) => f.endsWith(k)), c); },
  };
  const r = applyPatches(m, "/lab/firered", io);
  assert.equal(r.ok, true);
  assert.equal(r.changed, m.patches.length);
  for (const p of m.patches) {
    const content = files.get(p.file);
    assert.ok(content.includes(p.replace), `${p.file} 已写入 replace`);
  }
});

test("applyPatches 重放：第二轮全 skip 零写入（幂等收口）", () => {
  const m = ENGINES.firered;
  const files = new Map();
  for (const p of m.patches) files.set(p.file, `${files.get(p.file) ?? "import os\n"}${p.replace}\n`);
  let writes = 0;
  const io = {
    existsSync: (f) => [...files.keys()].some((k) => f.endsWith(k)),
    readFileSync: (f) => files.get([...files.keys()].find((k) => f.endsWith(k))),
    writeFileSync: () => { writes++; },
  };
  const r = applyPatches(m, "/lab/firered", io);
  assert.equal(r.ok, true);
  assert.equal(r.changed, 0);
  assert.equal(writes, 0, "零写入");
});

test("applyPatches 仓库未克隆：absent 且 ok=false（调用方决定报错）", () => {
  const r = applyPatches(ENGINES.firered, "/lab/firered", { existsSync: () => false });
  assert.equal(r.ok, false);
  assert.ok(r.files.every((f) => f.action === "absent"));
});
