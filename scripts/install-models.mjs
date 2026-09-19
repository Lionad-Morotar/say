#!/usr/bin/env node
// 引擎模型资产安装（s-deploy）：幂等可重跑，清单对齐运行时 src/engines 的目录名与权重文件。
// 模式：默认 = 就绪资产 skip + 缺失资产下载解包；--verify = 只审计不下载（exit 1 = 有缺项）。
// 证据链契约：真实下载/解包落 docs/research/deploy/raw-log.jsonl，skip 不入日志。
// 资产根经 XDG_CACHE_HOME 覆盖可整体挪进临时目录（回退冒烟与干净安装演练不触碰真实缓存）。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { ASSETS, assessGroup, channelsFor, logEvent, modelsRoot, sherpaModelsDir } from "./lib/deploy-config.mjs";

const verifyOnly = process.argv.includes("--verify");

/** curl 子进程包装：-f 必带，错误页才会以非零退出暴露，不会伪装成功污染证据链 */
function curl(args) {
  const cmd = ["curl", ...args];
  const started = new Date().toISOString();
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8", timeout: 45 * 60 * 1000 });
  return {
    cmdStr: cmd.join(" "),
    exit: r.status,
    started,
    ended: new Date().toISOString(),
    durationMs: Date.now() - Date.parse(started),
    stderrTail: (r.stderr ?? "").split("\n").filter(Boolean).slice(-3).join(" | "),
  };
}

/** 下载单组资产：GitHub 直连透传代理 env；HF 源额外走 HF_ENDPOINT 镜像 fallback（当前清单无 HF 源） */
async function downloadGroup(group, dest) {
  mkdirSync(path.dirname(dest), { recursive: true });
  let last = null;
  for (const ch of channelsFor(group.url)) {
    const args = ["-s", "-f", "-L", "-C", "-", "--retry", "2", "--connect-timeout", "15", "-o", dest, ch.url];
    const r = curl(args);
    const bytes = existsSync(dest) ? statSync(dest).size : 0;
    logEvent({
      phase: "download", engine: group.engine, cmd: r.cmdStr, exit: r.exit,
      started: r.started, ended: r.ended, durationMs: r.durationMs,
      outFile: dest, outBytes: bytes, stderrTail: r.stderrTail,
      netChannel: ch.net, url: ch.url,
      proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY ? "set" : "unset",
    });
    if (r.exit === 0 && bytes > 1024) return { ok: true, bytes, channel: ch.net };
    last = { ok: false, exit: r.exit, stderr: r.stderrTail, channel: ch.net };
  }
  return last;
}

/** tar.bz2 解包；包在盘而清单未就绪时也能自愈（上次下载完成但解包中断） */
async function extractGroup(group, env) {
  const pkg = path.join(sherpaModelsDir(env), path.basename(group.url));
  mkdirSync(sherpaModelsDir(env), { recursive: true });
  const started = new Date().toISOString();
  const r = spawnSync("tar", ["xjf", pkg, "-C", sherpaModelsDir(env)], { encoding: "utf8", timeout: 10 * 60 * 1000 });
  const ended = new Date().toISOString();
  logEvent({
    phase: "install", engine: group.engine, cmd: `tar xjf ${pkg} -C ${sherpaModelsDir(env)}`,
    exit: r.status, started, ended, durationMs: Date.now() - Date.parse(started),
    stderrTail: (r.stderr ?? "").split("\n").filter(Boolean).slice(-3).join(" | "),
  });
  return r.status === 0;
}

function summarize(name, a) {
  const status = a.ready ? "skip（已就绪）" : `缺 ${a.missing.length} 项：${a.missing.join(", ")}`;
  console.log(`[${a.ready ? "skip" : "MISSING"}] ${name} → ${status}`);
}

/** 引擎依赖检查（bin/say 运行必需的 npm 包）：只提示不代装，pnpm install 是 README 第一层 */
function checkNpmDeps() {
  const rows = ["sherpa-onnx-node", "smol-toml"].map((name) => {
    const ok = existsSync(path.join(import.meta.dirname, "..", "node_modules", name));
    return { name, ok };
  });
  const missing = rows.filter((r) => !r.ok).map((r) => r.name);
  if (missing.length > 0) console.warn(`warn: node_modules 缺 ${missing.join(", ")}，先跑 pnpm install`);
  return missing.length === 0;
}

async function main() {
  const env = process.env;
  if (verifyOnly) {
    let allOk = true;
    for (const g of ASSETS) {
      const a = assessGroup(g, env);
      if (!a.ready) allOk = false;
      console.log(`${a.ready ? "PASS" : "FAIL"}  ${g.id}  ${g.dir === null ? "（vocoder 单文件）" : a.base}`);
      if (!a.ready) console.log(`      缺项：${a.missing.join("; ")}（来源 ${g.url}）`);
    }
    console.log(`模型根目录：${modelsRoot(env)}（可用 XDG_CACHE_HOME 重定向）`);
    if (!checkNpmDeps()) allOk = false;
    process.exit(allOk ? 0 : 1);
  }

  let failed = 0;
  for (const g of ASSETS) {
    const a = assessGroup(g, env);
    if (a.ready) {
      summarize(g.id, a);
      continue;
    }
    const dest = g.dir === null
      ? path.join(modelsRoot(env), "sherpa", "vocoders", g.id)
      : path.join(sherpaModelsDir(env), path.basename(g.url));
    // 包在盘而清单未就绪 = 上次下载完成但解包中断：先解包自愈，包损坏才删掉重下（-C - 对完整包续传会 416）
    if (g.dir !== null && existsSync(dest)) {
      if ((await extractGroup(g, env)) && assessGroup(g, env).ready) {
        console.log(`[DONE]  ${g.id}（旧包解包自愈）`);
        continue;
      }
      rmSync(dest, { force: true });
    }
    if (g.dir === null && existsSync(dest)) {
      // 单文件资产体积不符才走到这里：残件删掉重下，否则 -C - 续传会保留损坏尾部
      rmSync(dest, { force: true });
    }
    const d = await downloadGroup(g, dest);
    if (!d.ok) {
      failed += 1;
      console.error(`[FAIL] ${g.id} 下载失败（exit ${d.exit}，通道 ${d.channel}）：${d.stderr || "字节阈值未达"}`);
      continue;
    }
    if (g.dir !== null) {
      const ok = await extractGroup(g, env);
      if (!ok) {
        failed += 1;
        console.error(`[FAIL] ${g.id} 解包失败`);
        continue;
      }
    }
    const after = assessGroup(g, env);
    if (!after.ready) {
      failed += 1;
      console.error(`[FAIL] ${g.id} 落地后仍缺项：${after.missing.join("; ")}`);
    } else {
      // 包已解包验证即删：cache 占地减半，包损坏的代价只是重下（marker 是解包产物而非压缩包）
      if (g.dir !== null) rmSync(dest, { force: true });
      console.log(`[DONE]  ${g.id}（下载通道 ${d.channel}）`);
    }
  }
  checkNpmDeps();
  console.log(failed === 0 ? "全部资产就绪" : `${failed} 组资产未就绪，可重跑自愈（断点续传 -C -）`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();