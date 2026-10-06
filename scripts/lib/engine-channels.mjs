// 下载通道与校验（engine-v2 S1）：ModelScope 优先 + hf-mirror 兜底的有序 fallback，sha256 全量校验。
// 下载器可注入（fetcher/download 参数）使单测不打真实网络；真实下载走 aria2c（-x16 实测 5.4MB/s）缺则回落 curl -C -。
// ModelScope resolve 的 308 重定向会把并行分段串到别的 LFS 对象（VoxCPM 票实证文件串写），故恒单文件逐个下载。
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, statSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 顺序取通道列表（manifest sources 已经是优先级序，此函数是 fallback 语义的显式承载点，
 * 未来加通道（如 ModelScope 302 CDN 直链解析）从这里扩展而不动调用方）
 */
export function channelsFor(asset) {
  return asset.sources;
}

/** 流式 sha256：大文件（8GB+ safetensors）不能整读进内存 */
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

/** 下载就绪判据：文件在且字节数与 manifest 一致（size 是廉价第一道防线，sha256 是最终裁决） */
export function sizeMatches(file, expected, stat = statSync) {
  try {
    return stat(file).size === expected;
  } catch {
    return false;
  }
}

/**
 * 单通道下载一次尝试。返回 { ok, bytes, tool, exit, stderrTail }。
 * aria2c 优先（多连接直链最快），不可用回落 curl（-C - 断点续传）。
 * 代理透传 = 继承当前进程 env（spawnSync 默认），aria2 对 all-proxy 与 https-proxy 都认。
 */
export function downloadOnce(url, dest, { timeoutMs = 4 * 60 * 60 * 1000 } = {}) {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const hasAria2 = spawnSync("aria2c", ["--version"], { encoding: "utf8" }).status === 0;
  let cmd, args;
  if (hasAria2) {
    cmd = "aria2c";
    args = [
      "-x", "16", "-s", "16", "-k", "1M",
      "--file-allocation=none", "--console-log-level=warn", "--summary-interval=0",
      "--connect-timeout=20", "--timeout=60", "--max-tries=2",
      "-d", dirname(dest), "-o", `${basename(dest)}.part`, "--auto-file-renaming=false", "--allow-overwrite=true", url,
    ];
  } else {
    cmd = "curl";
    args = ["-s", "-f", "-L", "-C", "-", "--retry", "2", "--connect-timeout", "20", "-o", tmp, url];
  }
  const started = Date.now();
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs });
  const ok = r.status === 0 && existsSync(tmp) && statSync(tmp).size > 0;
  if (ok) renameSync(tmp, dest);
  else rmSync(tmp, { force: true });
  return {
    ok,
    bytes: ok ? statSync(dest).size : 0,
    tool: cmd,
    exit: r.status,
    durationMs: Date.now() - started,
    stderrTail: (r.stderr ?? "").split("\n").filter(Boolean).slice(-3).join(" | "),
  };
}

function basename(p) {
  return p.split("/").pop();
}

/**
 * 带 fallback 的单资产下载：按通道序尝试，size 对得上才做 sha256 终验，
 * sha256 不匹配继续下一通道（308 串文件/坏分段都在这里被拦下）。
 * inject.download 覆盖真实下载（单测注入假下载器）；inject.hash 覆盖校验和计算；
 * inject.stat 覆盖 size 校验的文件面（假下载器不落盘，单测注入计数器）。
 */
export async function downloadAsset(asset, dest, { download = downloadOnce, hash = sha256File, log = () => {}, stat = statSync, remove = rmSync } = {}) {
  for (const ch of channelsFor(asset)) {
    if (!sizeMatches(dest, asset.size, stat)) {
      const r = await download(ch.url, dest);
      log({ phase: "download", channel: ch.net, url: ch.url, ...r });
      if (!r.ok || !sizeMatches(dest, asset.size, stat)) continue;
    }
    if (!asset.sha256) return { ok: true, channel: ch.net, verified: "size-only" };
    const actual = await hash(dest);
    if (actual !== asset.sha256) {
      log({ phase: "verify", channel: ch.net, url: ch.url, ok: false, expect: asset.sha256, actual });
      remove(dest, { force: true });
      continue;
    }
    return { ok: true, channel: ch.net, verified: "sha256" };
  }
  return { ok: false, channel: null, verified: null };
}
