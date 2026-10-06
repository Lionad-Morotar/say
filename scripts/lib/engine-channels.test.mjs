// 下载通道 fallback 单测：注入假下载器与 hash，不打真实网络；覆盖通道顺序、size/sha256 双防线与坏通道跳转。
import test from "node:test";
import assert from "node:assert/strict";
import { channelsFor, sizeMatches, downloadAsset } from "./engine-channels.mjs";

const ASSET = {
  file: "models/test.bin",
  size: 10,
  sha256: "a".repeat(64),
  sources: [
    { net: "modelscope", url: "https://modelscope.cn/models/o/m/resolve/master/test.bin" },
    { net: "hf-mirror", url: "https://hf-mirror.com/o/m/resolve/main/test.bin" },
  ],
};

/** 假文件面：download 闭包往 Map 写 size，stat 读 Map——模拟「下载器落盘」而不碰真实 fs */
function fakeFs(initial = new Map()) {
  const files = initial;
  return {
    stat: (p) => {
      if (!files.has(p)) throw new Error("ENOENT");
      return { size: files.get(p), isFile: () => true };
    },
    remove: (p) => files.delete(p),
    write: (p, size) => files.set(p, size),
    files,
  };
}

test("channelsFor 保持 manifest 声明的优先级序", () => {
  const ch = channelsFor(ASSET);
  assert.deepEqual(ch.map((c) => c.net), ["modelscope", "hf-mirror"]);
});

test("sizeMatches：存在且字节精确匹配为真，缺失或偏差为假", () => {
  const fs = fakeFs(new Map([["/d/ok", 10], ["/d/bad", 9]]));
  assert.equal(sizeMatches("/d/ok", 10, fs.stat), true);
  assert.equal(sizeMatches("/d/bad", 10, fs.stat), false);
  assert.equal(sizeMatches("/d/gone", 10, fs.stat), false);
});

test("首通道下载 + sha256 通过即收，不触后续通道", async () => {
  const fs = fakeFs();
  const calls = [];
  const r = await downloadAsset(ASSET, "/d/f", {
    download: async (url) => { calls.push(url); fs.write("/d/f", 10); return { ok: true, bytes: 10 }; },
    hash: async () => ASSET.sha256,
    stat: fs.stat,
    remove: fs.remove,
  });
  assert.equal(r.ok, true);
  assert.equal(r.channel, "modelscope");
  assert.equal(r.verified, "sha256");
  assert.equal(calls.length, 1);
});

test("首通道 sha256 不匹配（308 串文件形态）→ 删除落盘 → 落第二通道成功", async () => {
  const fs = fakeFs();
  const verifyFails = [];
  let removedCount = 0;
  let downloads = 0;
  const r = await downloadAsset(ASSET, "/d/f", {
    download: async () => { downloads++; fs.write("/d/f", 10); return { ok: true, bytes: 10 }; },
    hash: async () => (downloads === 1 ? "b".repeat(64) : ASSET.sha256),
    stat: fs.stat,
    remove: (p) => { removedCount++; return fs.remove(p); },
    log: (e) => { if (e.phase === "verify") verifyFails.push(e.channel); },
  });
  assert.equal(r.ok, true);
  assert.equal(r.channel, "hf-mirror");
  assert.equal(downloads, 2);
  assert.deepEqual(verifyFails, ["modelscope"], "坏 sha256 有留痕");
  assert.equal(removedCount, 1, "坏文件被删（防半截文件冒充就绪；第二通道成功后在盘的是好文件）");
  assert.equal(fs.files.get("/d/f"), 10);
});

test("下载后 size 不符（字节截断形态）同样落下一通道", async () => {
  const fs = fakeFs();
  let downloads = 0;
  const r = await downloadAsset(ASSET, "/d/f", {
    download: async () => { downloads++; fs.write("/d/f", downloads === 1 ? 7 : 10); return { ok: true, bytes: downloads === 1 ? 7 : 10 }; },
    hash: async () => ASSET.sha256,
    stat: fs.stat,
    remove: fs.remove,
  });
  assert.equal(r.ok, true);
  assert.equal(r.channel, "hf-mirror");
  assert.equal(downloads, 2);
});

test("首通道下载失败（非零退出/零字节）直接落下一通道", async () => {
  const fs = fakeFs();
  const urls = [];
  const r = await downloadAsset(ASSET, "/d/f", {
    download: async (url) => {
      urls.push(url);
      if (url.includes("modelscope")) return { ok: false, bytes: 0 };
      fs.write("/d/f", 10);
      return { ok: true, bytes: 10 };
    },
    hash: async () => ASSET.sha256,
    stat: fs.stat,
    remove: fs.remove,
  });
  assert.equal(r.ok, true);
  assert.equal(r.channel, "hf-mirror");
  assert.equal(urls.length, 2);
});

test("全通道失败返回 ok:false（不抛异常，调用方决定退出码）", async () => {
  const fs = fakeFs();
  const r = await downloadAsset(ASSET, "/d/f", {
    download: async () => ({ ok: false, bytes: 0 }),
    hash: async () => "x".repeat(64),
    stat: fs.stat,
    remove: fs.remove,
  });
  assert.equal(r.ok, false);
  assert.equal(r.channel, null);
});

test("无 sha256 的 auto 资产走 size-only 判定", async () => {
  const fs = fakeFs();
  const r = await downloadAsset({ ...ASSET, sha256: "" }, "/d/f", {
    download: async () => { fs.write("/d/f", 10); return { ok: true, bytes: 10 }; },
    stat: fs.stat,
    remove: fs.remove,
  });
  assert.equal(r.ok, true);
  assert.equal(r.verified, "size-only");
});

test("dest 已完整在盘时短路，不发起任何下载", async () => {
  const fs = fakeFs(new Map([["/d/f", 10]]));
  let downloads = 0;
  const r = await downloadAsset(ASSET, "/d/f", {
    download: async () => { downloads++; return { ok: true, bytes: 10 }; },
    hash: async () => ASSET.sha256,
    stat: fs.stat,
    remove: fs.remove,
  });
  assert.equal(r.ok, true);
  assert.equal(downloads, 0, "幂等短路：完整文件在盘不再下载");
});
