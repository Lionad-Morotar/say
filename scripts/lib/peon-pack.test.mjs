// peon-ping 通道单测：manifest 解析与通道编排在注入面下复验，不打真实网络与真实资产盘。
// node:test 形态对齐 scripts/lib 既有先例（vitest include 只收 test/**/*.test.ts）。
import test from "node:test";
import assert from "node:assert/strict";
import {
  PEON_DVA_MANIFEST,
  peonDvaTargets,
  parseRegistryEntry,
  judgePeonFile,
  checkPeonSet,
  runPeonChannel,
} from "./peon-pack.mjs";

const HEX64 = /^[0-9a-f]{64}$/;

test("钉版 manifest 自洽：17 条、文件名唯一、bytes 为正、sha256 全 64 位 hex", () => {
  assert.equal(PEON_DVA_MANIFEST.length, 17);
  const names = PEON_DVA_MANIFEST.map((m) => m.file);
  assert.equal(new Set(names).size, 17, "文件名不得重复");
  for (const m of PEON_DVA_MANIFEST) {
    assert.ok(m.bytes > 0, `${m.file} bytes 必须为正`);
    assert.match(m.sha256, HEX64, `${m.file} sha256 必须是 64 位 hex`);
  }
});

test("peonDvaTargets 拼装：URL 指向钉版仓库 ref，dest 落指定目录", () => {
  const targets = peonDvaTargets("/fake/dir");
  assert.equal(targets.length, 17);
  for (const t of targets) {
    assert.ok(t.url.startsWith("https://raw.githubusercontent.com/leo-rutter/d.va-pack/v1.0.0/sounds/"), t.url);
    assert.equal(t.dest, `/fake/dir/${t.file}`);
  }
  const defaults = peonDvaTargets();
  assert.ok(defaults[0].dest.endsWith(".mp3"), "缺省目录时仍产出合法路径");
});

const REGISTRY_OK = {
  packs: [
    { name: "other", source_repo: "a/b", sound_count: 3 },
    {
      name: "dva",
      source_repo: "leo-rutter/d.va-pack",
      source_ref: "v1.0.0",
      sound_count: 17,
      manifest_sha256: "a".repeat(64),
    },
  ],
};

test("parseRegistryEntry：正常条目解析出钉版前提", () => {
  const r = parseRegistryEntry(REGISTRY_OK);
  assert.equal(r.ok, true, r.reasons?.join("; "));
  assert.equal(r.entry.source_ref, "v1.0.0");
});

test("parseRegistryEntry：registry 缺 dva 条目判失败", () => {
  const r = parseRegistryEntry({ packs: [{ name: "zarya" }] });
  assert.equal(r.ok, false);
  assert.match(r.reasons[0], /无 dva 包条目/);
});

test("parseRegistryEntry：sound_count 与钉版不符判失败（上游漂移探测）", () => {
  const idx = structuredClone(REGISTRY_OK);
  idx.packs[1].sound_count = 16;
  const r = parseRegistryEntry(idx);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes("sound_count")));
});

test("parseRegistryEntry：来源仓库漂移判失败，注册表不是改写来源的授权", () => {
  const idx = structuredClone(REGISTRY_OK);
  idx.packs[1].source_repo = "someone-else/dva-pack";
  const r = parseRegistryEntry(idx);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes("source_repo")));
});

test("parseRegistryEntry：manifest_sha256 非 hex 判失败", () => {
  const idx = structuredClone(REGISTRY_OK);
  idx.packs[1].manifest_sha256 = "truncated";
  const r = parseRegistryEntry(idx);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes("manifest_sha256")));
});

test("parseRegistryEntry：非注册表形态（缺 packs）判失败", () => {
  const r = parseRegistryEntry({ foo: 1 });
  assert.equal(r.ok, false);
  assert.match(r.reasons[0], /packs/);
});

test("judgePeonFile 三态：ok / missing / corrupt", () => {
  const expected = { bytes: 10, sha256: "a".repeat(64) };
  assert.equal(judgePeonFile(expected, null), "missing");
  assert.equal(judgePeonFile(expected, { bytes: 10, sha256: "a".repeat(64) }), "ok");
  assert.equal(judgePeonFile(expected, { bytes: 9, sha256: "a".repeat(64) }), "corrupt");
  assert.equal(judgePeonFile(expected, { bytes: 10, sha256: "b".repeat(64) }), "corrupt");
});

function judgedWith(overrides = {}) {
  const rows = PEON_DVA_MANIFEST.map((m) => ({
    file: m.file,
    verdict: overrides[m.file] ?? "ok",
  }));
  if (overrides.drop) return rows.filter((r) => !overrides.drop.includes(r.file));
  return rows;
}

test("checkPeonSet：全 ok 放行", () => {
  const r = checkPeonSet(judgedWith());
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.corrupt, []);
});

test("checkPeonSet：缺档与损坏分别归集，整集不放行", () => {
  const r = checkPeonSet(judgedWith({ "gg.mp3": "missing", "hi.mp3": "corrupt" }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["gg.mp3"]);
  assert.deepEqual(r.corrupt, ["hi.mp3"]);
});

test("checkPeonSet：条数不足判失败（防漏检）", () => {
  const r = checkPeonSet(judgedWith({ drop: ["gg.mp3"] }).map((x) => ({ ...x, verdict: "ok" })));
  assert.equal(r.ok, false);
});

/** 假 IO 面：内存盘 + 可编程下载器，覆盖幂等 skip / 损坏重下 / 失败归集 */
function fakeIo(initial = new Map(), downloadImpl = null) {
  const store = initial;
  const calls = [];
  return {
    store,
    calls,
    io: {
      measure: async (f) => store.get(f) ?? null,
      download: async (url, dest) => {
        calls.push({ url, dest });
        if (downloadImpl) return downloadImpl(url, dest, store);
        // 默认落「好内容」：模拟真实下载器成功写盘，使首轮断言聚焦通道编排而非下载器
        const t = peonDvaTargets("/fake").find((x) => x.dest === dest);
        if (t) store.set(dest, blob(t.bytes, t.sha256));
        return { ok: true, exit: 0, stderrTail: "", viaProxy: false };
      },
      log: () => {},
    },
  };
}
const blob = (bytes, hex) => ({ bytes, sha256: hex });

test("runPeonChannel：空盘首轮全下载，二轮全 skip（幂等）", async () => {
  const { io, calls } = fakeIo();
  const r1 = await runPeonChannel("/fake", io);
  assert.equal(r1.ok, true);
  assert.equal(r1.downloaded, 17);
  assert.equal(r1.skipped, 0);
  assert.equal(calls.length, 17);
  calls.length = 0;
  const r2 = await runPeonChannel("/fake", io);
  assert.equal(r2.ok, true);
  assert.equal(r2.downloaded, 0);
  assert.equal(r2.skipped, 17);
  assert.equal(calls.length, 0, "幂等轮次不得发起任何下载");
});

test("runPeonChannel：损坏文件触发重下且重下后达标", async () => {
  const t0 = peonDvaTargets("/fake")[0];
  const { io, calls } = fakeIo(new Map([[t0.dest, blob(1, "c".repeat(64))]]));
  const r1 = await runPeonChannel("/fake", io);
  assert.equal(r1.downloaded, 17, "损坏条目与缺失条目同等触发下载");
  assert.equal(calls.length, 17);
  calls.length = 0;
  const r2 = await runPeonChannel("/fake", io);
  assert.equal(r2.skipped, 17);
  assert.equal(calls.length, 0);
});

test("runPeonChannel：下载后校验仍不符归集 failures 且整体不 ok", async () => {
  const { io } = fakeIo(
    new Map(),
    (_url, _dest, store) => {
      // 假下载器落「坏内容」
      store.set(_dest, blob(999, "e".repeat(64)));
      return { ok: true, exit: 0, stderrTail: "", viaProxy: false };
    },
  );
  const r = await runPeonChannel("/fake", io);
  assert.equal(r.ok, false);
  assert.equal(r.failures.length, 17);
});

test("runPeonChannel：下载器报错不冒充成功", async () => {
  const { io, store } = fakeIo(
    new Map(),
    () => ({ ok: false, exit: 28, stderrTail: "timeout", viaProxy: true }),
  );
  const r = await runPeonChannel("/fake", io);
  assert.equal(r.ok, false);
  assert.equal(store.size, 0, "失败下载不得在假盘留下文件");
});
