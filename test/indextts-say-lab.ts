/**
 * say-lab indextts 真机安装面的收集期探活与 per-call 直驱原语（S4 验收套件共享）。
 *
 * 门控纪律（env-gate 与可用性解耦教训）：探活在收集期完成、判据是「能力在场」而非
 * env 存在——venv+torch、权重文件级在场、auto 层首跑产物在场三层分别探测，
 * 缺任一层对应套件 skip 而非 fail，检出无引擎的机器上全量照绿。
 * 必须走 userInfo().homedir：vitest 配置注入 HOME=/nonexistent-say-test-home
 * （接缝隔离），os.homedir()/HOME 推导在本套件里必然落空。
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";

export const SHIM = fileURLToPath(new URL("../scripts/shims/indextts-shim.py", import.meta.url));
export const SHIMS_DIR = dirname(SHIM);

export const LAB = process.env.SAY_LAB_DIR ?? join(userInfo().homedir, ".local/share/say-lab", "indextts");
export const REPO = join(LAB, "index-tts");
export const CHECKPOINTS = join(LAB, "checkpoints");
const HF_CACHE = join(CHECKPOINTS, "hf_cache");

/** venv 三形态解析（与 src/engines/indextts.ts resolveLabPython 同序）+ torch 可 import 实证 */
export const VENV_PYTHON: string | null = (() => {
  for (const rel of ["venv/bin/python", ".venv/bin/python", "index-tts/.venv/bin/python"]) {
    const p = join(LAB, rel);
    if (!existsSync(p)) continue;
    try {
      execFileSync(p, ["-c", "import torch"], { timeout: 180_000, stdio: "pipe" });
      return p;
    } catch {
      return null;
    }
  }
  return null;
})();

/** 真实引擎代码在位（集成面前提：patch 打的属性表来自这份源码） */
export const ENGINE = VENV_PYTHON !== null && existsSync(join(REPO, "indextts/infer_v2_5.py")) && existsSync(join(CHECKPOINTS, "config.yaml"));

/** 主权重面：九件文件级在场且 gpt.pth 非占位（>1GB 才是票 01 实测量级） */
function mainWeightsReady(): boolean {
  const nine = [
    "gpt.pth",
    "codec.pth",
    "s2mel.pth",
    "qwen0.6bemo4-merge/model.safetensors",
    "config.yaml",
    "feat1.pt",
    "feat2.pt",
    "wav2vec2bert_stats.pt",
    "multilingual_zh_ja_yue_char_del.tiktoken",
  ];
  if (!nine.every((f) => existsSync(join(CHECKPOINTS, f)))) return false;
  try {
    return statSync(join(CHECKPOINTS, "gpt.pth")).size > 1_000_000_000;
  } catch {
    return false;
  }
}

/** auto 层（引擎首跑自拉件，daemon 指纹投影刻意排除的面）：合成路径必需 */
function autoLayerReady(): boolean {
  const w2v = join(HF_CACHE, "w2v-bert-2.0");
  const bigvgan = join(HF_CACHE, "bigvgan");
  return (
    existsSync(w2v) && readdirSync(w2v).length > 0 &&
    existsSync(join(HF_CACHE, "campplus_cn_common.bin")) &&
    existsSync(bigvgan) && readdirSync(bigvgan).length > 0
  );
}

/** 真合成面：venv+引擎+主权重+auto 层+引擎示例参考音频全部在场 */
export const SYNTH = ENGINE && mainWeightsReady() && autoLayerReady() && existsSync(join(REPO, "examples/voice_01.wav"));
export const REF_AUDIO = join(REPO, "examples/voice_01.wav");

export interface ShimRunResult {
  frames: Array<Record<string, unknown>>;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** spawn → ready 帧毫秒计时（取证口径；断言归取证轮，套件不钉性能值） */
  readyMs: number | null;
}

/**
 * per-call 形态直驱：起进程、按序写请求行、收帧至进程自然退出或超时强杀。
 * 真实二进制单跑——vitest 替身面结构性摸不到的加载时序缺陷（宿主空心循环类）
 * 只有这里能暴露。env 追加经 extraEnv（如 HF_HUB_OFFLINE=1 网络隔离）。
 */
export function runShimPerCall(
  requests: Array<Record<string, unknown>>,
  opts: { modelsDir?: string; timeoutMs: number; extraEnv?: Record<string, string> },
): Promise<ShimRunResult> {
  const python = VENV_PYTHON as string;
  const proc = spawn(python, [SHIM, "--repo", REPO, "--models", opts.modelsDir ?? CHECKPOINTS], {
    env: { ...process.env, PYTHONPATH: "", ...(opts.extraEnv ?? {}) },
  });
  const t0 = performance.now();
  let stdout = "";
  let stderr = "";
  let readyMs: number | null = null;
  proc.stdout.on("data", (d) => {
    stdout += d.toString();
    if (readyMs === null && /"type":\s*"ready"/.test(stdout)) readyMs = performance.now() - t0;
  });
  proc.stderr.on("data", (d) => (stderr += d.toString()));
  for (const req of requests) proc.stdin.write(JSON.stringify(req) + "\n");
  proc.stdin.end();

  return new Promise((resolve, reject) => {
    const killer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`shim ${opts.timeoutMs}ms 未退出；stdout 尾=${stdout.slice(-400)}`));
    }, opts.timeoutMs);
    proc.on("error", (e) => {
      clearTimeout(killer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(killer);
      const frames = stdout
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      resolve({ frames, stdout, stderr, exitCode: code, readyMs });
    });
  });
}
