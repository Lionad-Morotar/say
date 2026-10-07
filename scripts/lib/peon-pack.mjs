// peon-ping D.Va 增补包通道（engine-v2 S7）：leo-rutter/d.va-pack v1.0.0，17 条游戏原生干音
//（无 BGM，22.05kHz/96kbps），定位为 GPT-SoVITS 分句训练集候选，不作零样本主参考
//（18.8s 碎句凑不出 10-30s 连续段，调研票 05 裁决）。许可 CC-BY-NC-4.0（格式许可），
// 按官方公开素材、本机个人使用、不再分发口径持有，资产只落 VOICES_DIR 不入 git。
// sha256 钉版是首采实测值：上游 openpeon.json 无逐文件哈希、GitHub contents API 的 sha
// 是 git blob SHA-1 均不可作内容判据，钉实测值同时承担下载校验与上游漂移探测双责；
// 表值由下载探针脚本生成，禁止人工转录后无 diff 校验入码（长哈希人肉比对必错前科）。
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { PEON_DVA_DIR } from "./config.mjs";

const PEON_DVA_REPO = "leo-rutter/d.va-pack";
const PEON_DVA_REF = "v1.0.0";
export const PEON_DVA_RAW_BASE = `https://raw.githubusercontent.com/${PEON_DVA_REPO}/${PEON_DVA_REF}/sounds`;

/** 17 条干音钉版清单（bytes 与 GitHub contents API size 逐条互证）。 */
export const PEON_DVA_MANIFEST = [
  { file: "annyoung.mp3", bytes: 12107, sha256: "07fe5a9ede2b5a5438c8094321a44903435a9cdebb11e776f2b4b11b09720ed5" },
  { file: "boosters-engaged.mp3", bytes: 19943, sha256: "5a15537a810d9003ed4b95c389c33eebfab85807cf6d2c6add993d8b453bb23b" },
  { file: "ding.mp3", bytes: 12107, sha256: "04c6bf00cf47dd6db92e91ad99b2a116d5271a489b5167d503b0d459863e3db7" },
  { file: "dva-online.mp3", bytes: 18063, sha256: "322ba4e67ff226211b959985c9636c823e75602cf4d7b526d8a9e9bf48ebdaf2" },
  { file: "ejecting.mp3", bytes: 15241, sha256: "b75870cb79cf9f7bb81bc493907f5bcef7da25c4bfc2637c08ba42d553e58f25" },
  { file: "gg.mp3", bytes: 29348, sha256: "1d08d87ea54d4cbc90dccf96501f78f1fbb8455889d04e68de15fbaf34c805c8" },
  { file: "got-it.mp3", bytes: 10226, sha256: "ce08d9d222ec1b7e2d1fec0218788c425486224fcb83e876a31d4ddaa01e0d08" },
  { file: "hi.mp3", bytes: 12107, sha256: "821b792e21281e7f9b8fa2ada5003301a2332bdf77c6aa3692fe3d99cbaa283c" },
  { file: "i-could-use-a-hand.mp3", bytes: 19317, sha256: "4ac6620a68fa48b2a9eaed9d443751ebc6bb6f713ea076423a9ca18a2a2f5f33" },
  { file: "im-back-in-the-fight.mp3", bytes: 19003, sha256: "3c24d76e2c9727762d73ff2eca1932de451125ca3dc2ebbbd87e13979378f05c" },
  { file: "kr.mp3", bytes: 13047, sha256: "1110540687455c67d759dbfbeca7eb57c41f13a362be9f48895e8575985a498a" },
  { file: "need-healing.mp3", bytes: 16495, sha256: "c21c0d6d01aa94ccc6840c8c6f74b28b370983aa3fe35ea247cfa9641dec34c6" },
  { file: "nerf-this.mp3", bytes: 23078, sha256: "8cdfe7de30a7d8f4fa575b626470f69fda03ad89a079dcff45296e0bcacf0524" },
  { file: "okay.mp3", bytes: 12107, sha256: "332ed713ec0c8c5e0ba1613fcee2d9c5fde63f4969b9f107d021687b200bd2da" },
  { file: "roger.mp3", bytes: 11793, sha256: "3ebbdbd32f9a0ee52e957f0dbd38c1ccb2d787453e09480a4c982664e8db8191" },
  { file: "time-to-raise-my-apm.mp3", bytes: 26840, sha256: "0a5dc21be44bc34a08706491cfb78e8cc8384d99aa9d038c05ab78b5dbef1d2c" },
  { file: "winky-face.mp3", bytes: 14928, sha256: "b16bae2eec766d84feaec3b6d493786f3d01b38ddbc137e82529881c9781fcc6" },
];

/** 拼装下载目标：{file, url, bytes, sha256}，dir 缺省走资产位 */
export function peonDvaTargets(dir = PEON_DVA_DIR) {
  return PEON_DVA_MANIFEST.map((m) => ({ ...m, url: `${PEON_DVA_RAW_BASE}/${m.file}`, dest: path.join(dir, m.file) }));
}

/**
 * 注册表条目解析（纯函数）：定位 dva 包并校验钉版前提（来源仓库/引用/条数）。
 * 注册表是发现面不是数据面，条目与钉版表不符即判失败，不静默改按注册表下载。
 */
export function parseRegistryEntry(indexJson, { packName = "dva", expectedCount = PEON_DVA_MANIFEST.length, expectedRepo = PEON_DVA_REPO } = {}) {
  const reasons = [];
  const packs = Array.isArray(indexJson?.packs) ? indexJson.packs : null;
  if (!packs) return { ok: false, entry: null, reasons: ["registry index 缺 packs 数组"] };
  const entry = packs.find((p) => p?.name === packName) ?? null;
  if (!entry) return { ok: false, entry: null, reasons: [`registry 无 ${packName} 包条目`] };
  if (entry.source_repo !== expectedRepo) reasons.push(`source_repo ${entry.source_repo} ≠ 钉版 ${expectedRepo}`);
  if (typeof entry.source_ref !== "string" || entry.source_ref === "") reasons.push("source_ref 缺失");
  if (entry.sound_count !== expectedCount) reasons.push(`sound_count ${entry.sound_count} ≠ 钉版 ${expectedCount}`);
  if (typeof entry.manifest_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.manifest_sha256)) reasons.push("manifest_sha256 非 64 位 hex");
  return { ok: reasons.length === 0, entry, reasons };
}

/** 单文件判定（纯函数）：ok = 在盘且字节与哈希双匹配；missing = 不在盘；corrupt = 在盘但不匹配 */
export function judgePeonFile(expected, actual) {
  if (actual == null) return "missing";
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) return "corrupt";
  return "ok";
}

/** 整集判定（纯函数）：任何 missing/corrupt 都不放行 */
export function checkPeonSet(judged) {
  const missing = judged.filter((r) => r.verdict === "missing").map((r) => r.file);
  const corrupt = judged.filter((r) => r.verdict === "corrupt").map((r) => r.file);
  const ok = judged.length === PEON_DVA_MANIFEST.length && missing.length === 0 && corrupt.length === 0;
  return { ok, missing, corrupt };
}

// —— 流式 sha256（对齐 engine-channels 同名原语，避免跨模块引 scripts/lib 私有面）——

/** 流式 sha256：单条虽小，口径统一不给整读开先例 */
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

/** 在盘文件实测（缺失返回 null，不猜测） */
export async function measurePeonFile(file) {
  if (!existsSync(file)) return null;
  return { bytes: statSync(file).size, sha256: await sha256File(file) };
}

/**
 * 单文件下载一次尝试（curl，直连失败走本机代理重试一次）。
 * raw.githubusercontent.com 在上海网络直连常超时（首采实证），代理为可用性兜底而非首选。
 * .part 临时名 + rename 原子落盘，半途失败不留半截文件冒充在盘。
 */
export function downloadPeonFileOnce(url, dest, { proxy = "http://127.0.0.1:7897" } = {}) {
  const tmp = `${dest}.part`;
  let r = spawnSync("curl", ["-sfL", "--retry", "2", "--connect-timeout", "15", "-o", tmp, url], { encoding: "utf8", timeout: 300_000 });
  let viaProxy = false;
  if (r.status !== 0 && proxy) {
    r = spawnSync("curl", ["-sfL", "--retry", "2", "--connect-timeout", "20", "--proxy", proxy, "-o", tmp, url], { encoding: "utf8", timeout: 300_000 });
    viaProxy = true;
  }
  if (r.status !== 0) return { ok: false, exit: r.status, stderrTail: (r.stderr ?? "").slice(-500), viaProxy };
  renameSync(tmp, dest);
  return { ok: true, exit: 0, stderrTail: (r.stderr ?? "").slice(-500), viaProxy };
}

/**
 * 增补通道编排：逐条判定 → missing/corrupt 才下载 → 下载后复测双匹配。
 * @param {string} dir 资产目录
 * @param {{download?: typeof downloadPeonFileOnce, measure?: typeof measurePeonFile, log?: (e: object) => void}} io 注入面（单测不打真网络/真盘）
 * @returns {Promise<{ok:boolean, skipped:number, downloaded:number, failures:string[]}>}
 */
export async function runPeonChannel(dir = PEON_DVA_DIR, io = {}) {
  const download = io.download ?? downloadPeonFileOnce;
  const measure = io.measure ?? measurePeonFile;
  const log = io.log ?? (() => {});
  let skipped = 0;
  let downloaded = 0;
  const failures = [];
  for (const t of peonDvaTargets(dir)) {
    const verdict = judgePeonFile(t, await measure(t.dest));
    if (verdict === "ok") {
      skipped += 1;
      console.log(`[skip] peon-ping ${t.file} 字节与 sha256 双匹配`);
      continue;
    }
    if (verdict === "corrupt") console.log(`[redownload] peon-ping ${t.file} 在盘但校验不符，重下`);
    const startMs = Date.now();
    const r = download(t.url, t.dest);
    const af = await measure(t.dest);
    const after = judgePeonFile(t, af);
    log({
      phase: "download",
      engine: "voicepack-peon-ping",
      cmd: `curl -sfL -o ${t.dest} ${t.url}`,
      exit: after === "ok" ? 0 : (r.exit ?? 1),
      started: new Date(startMs).toISOString(),
      ended: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      outFile: after === "ok" ? t.dest : null,
      outBytes: af?.bytes ?? null,
      stderrTail: r.stderrTail ?? "",
      url: t.url,
    });
    if (after === "ok") {
      downloaded += 1;
      console.log(`[done] peon-ping ${t.file}（${af.bytes}B${r.viaProxy ? "，代理通道" : ""}）`);
    } else {
      failures.push(`${t.file}（verdict=${after}，curl exit=${r.exit ?? "?"}）`);
    }
  }
  return { ok: failures.length === 0, skipped, downloaded, failures };
}
