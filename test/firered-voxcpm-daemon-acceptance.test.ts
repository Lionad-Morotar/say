import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { assessPcm } from "./pcm-verdict.ts";
import { FIRERED_WEIGHT_MARKERS, VOXCPM_WEIGHT_MARKERS, weightsFingerprint } from "../src/engines/daemon-session.ts";
import { fireredDevice } from "../src/engines/firered-binding.ts";
import {
  decodePcmToInt16,
  FIRERED_LAB,
  FIRERED_PROMPT_TEXT,
  FIRERED_PROMPT_WAV,
  FIRERED_SHIM,
  FIRERED_SYNTH,
  FIRERED_VENV_PYTHON,
  startDaemonShim,
  VOXCPM_LAB,
  VOXCPM_SHIM,
  VOXCPM_SYNTH,
  VOXCPM_VENV_PYTHON,
} from "./firered-voxcpm-say-lab.ts";

/**
 * S5 真机验收套件（firered + voxcpm daemon 化）：真 venv、真权重、真 MPS 的端到端常驻链路。
 *
 * 套件面钉「机制与质量」而非「性能绝对值」——温态 ≤8s/≤5s 的 burst 数值归取证文档
 * （docs/debug/261008/，绝对计时受宿主负载病态影响不可复现，本套件所在机器实测
 * load1 5~150 波动），这里守的是 fake 摸不到的一层：
 * 1. 握手三元组在真 venv/真权重加载路径上的对拍：ready 版本键与 TS 侧同公式现算值一致；
 *    真实磁盘投影（大权重 mtime 精度）由独立的 --print-fingerprint 对拍用例覆盖。
 * 2. 合成音频数值有效性（assessPcm 能量/削波判据，S4 教训：时长挡不住静音）。
 * 3. 生命周期收口真形态：SIGTERM 优雅退 exit 0 + sock/pid 清净；idle 自收割（收窗档）；
 *    SIGKILL 残file 后新 daemon unlink-rebind 真恢复。
 *
 * lab 隔离（S4 先例）：daemon 的 --lab 走每用例独立 tmp 目录——注册点（sock/pid/log）
 * 与真实在位 daemon 完全分离，不触碰也不被用户环境的常驻进程顶 bind（exit 3 竞态），
 * 而 --repo/--models 仍指真引擎面：加载、推理、数值断言全部真实。
 * tmp lab 下的指纹 = missing 投影，两侧同公式仍相等（跨语言公式一致性断言不弱化）；
 * 「真实磁盘投影」面由 print-fingerprint 对拍用例专门覆盖。
 *
 * 门控：收集期探活（venv+torch/voxcpm import、权重文件级在场），缺引擎整组 skip。
 */

function pcmFromFrames(frames: Record<string, unknown>[]): { pcm: Int16Array; sampleRate: number } {
  const parts = frames.map((f) => decodePcmToInt16(String(f.pcm)));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const merged = new Int16Array(total);
  let offset = 0;
  for (const p of parts) {
    merged.set(p, offset);
    offset += p.length;
  }
  const sampleRate = Number(frames[frames.length - 1]!.sample_rate);
  return { pcm: merged, sampleRate };
}

function withTempLab(run: (lab: string) => Promise<void>): Promise<void> {
  const lab = mkdtempSync(join(tmpdir(), "say-s5acc-"));
  return run(lab).finally(() => rmSync(lab, { recursive: true, force: true }));
}

function readLog(lab: string): string {
  try {
    return readFileSync(join(lab, "daemon.log"), "utf8");
  } catch {
    return "";
  }
}

describe("S5 指纹真实安装面对拍（--print-fingerprint vs TS 现算，真权重 mtime 精度）", () => {
  it.skipIf(!FIRERED_SYNTH)("firered 真 lab 磁盘投影：venv 外系统 python 也能跑 print-fingerprint，两侧逐字节一致", () => {
    const py = execFileSync("python3", [FIRERED_SHIM, "--print-fingerprint", "--lab", FIRERED_LAB], { encoding: "utf8", timeout: 30_000 }).trim();
    expect(py).toBe(weightsFingerprint(FIRERED_LAB, FIRERED_WEIGHT_MARKERS));
  });

  it.skipIf(!VOXCPM_SYNTH)("voxcpm 真 lab 磁盘投影：print-fingerprint 免引擎 import，两侧逐字节一致", () => {
    const py = execFileSync("python3", [VOXCPM_SHIM, "--print-fingerprint", "--lab", VOXCPM_LAB], { encoding: "utf8", timeout: 30_000 }).trim();
    expect(py).toBe(weightsFingerprint(VOXCPM_LAB, VOXCPM_WEIGHT_MARKERS));
  });
});

describe("firered daemon 真机链路（握手版本键 + 温态合成数值 + 优雅退）", () => {
  it.skipIf(!FIRERED_SYNTH)(
    "spawn --daemon（tmp lab 注册点 + 真权重加载）→ ready 版本键与 TS 同公式一致 → en 文本克隆合成数值有效 → SIGTERM exit 0 且 sock/pid 清净",
    async () => {
      await withTempLab(async (lab) => {
        const python = FIRERED_VENV_PYTHON as string;
        const handle = startDaemonShim(
          python,
          [FIRERED_SHIM, "--daemon", "--repo", join(FIRERED_LAB, "FireRedTTS3"), "--models", join(FIRERED_LAB, "models", "FireRedTTS3"), "--lab", lab],
          { env: { FIRERED_DEVICE: fireredDevice(process.env as Record<string, string | undefined>) }, readyTimeoutMs: 300_000 },
        );
        const client = await handle.client;
        try {
          expect(client.readyFrame.type).toBe("ready");
          expect(client.readyFrame.engine).toBe("firered");
          expect(client.readyFrame.version).toBe("3");
          expect(client.readyFrame.protocol).toBe("2");
          // 真权重加载路径的 daemon 自述指纹 = TS 对同一（tmp）投影现算：跨语言公式在真实运行体上一致
          expect(String(client.readyFrame.weights_fingerprint)).toBe(weightsFingerprint(lab, FIRERED_WEIGHT_MARKERS));
          expect(Number(client.readyFrame.pid)).toBeGreaterThan(0);

          const frames = await client.request(
            {
              type: "synthesize",
              id: 1,
              text: "Warm daemon acceptance, the audio values must be real speech.",
              ref_audio_path: FIRERED_PROMPT_WAV,
              prompt_text: FIRERED_PROMPT_TEXT,
              text_lang: "en",
            },
            300_000,
          );
          const done = frames[frames.length - 1]!;
          expect(done.type).toBe("audio");
          expect(done.done).toBe(true);
          const { pcm, sampleRate } = pcmFromFrames(frames.filter((f) => f.type === "audio"));
          const verdict = assessPcm(pcm, sampleRate);
          expect(verdict.ok, `温态合成数值退化：${verdict.defect}（rms=${verdict.rms.toFixed(0)} dur=${verdict.durationS.toFixed(2)}s）`).toBe(true);
        } finally {
          handle.kill("SIGTERM");
          const exit = await handle.exit;
          expect(exit.code, `SIGTERM 应优雅退 exit 0（signal=${exit.signal}，log 尾=${readLog(lab).slice(-200)}）`).toBe(0);
        }
        expect(existsSync(join(lab, "daemon.sock"))).toBe(false);
        expect(existsSync(join(lab, "daemon.pid"))).toBe(false);
      });
    },
    320_000,
  );
});

describe("voxcpm daemon 真机链路（运行时类名握手 + 流式多帧数值 + idle 自收割）", () => {
  it.skipIf(!VOXCPM_SYNTH)(
    "spawn --daemon → ready.version 等于钉版类名 → 流式帧序 done 终结、拼接音频数值有效 → 闲置超阈自收割 exit 0 清净",
    async () => {
      await withTempLab(async (lab) => {
        const python = VOXCPM_VENV_PYTHON as string;
        // --idle-minutes 0.2 = 12s：真机验证收割机制本身（阈值的 per-engine 钉版数值归取证与 shim 缺省）
        const handle = startDaemonShim(python, [VOXCPM_SHIM, "--daemon", "--models", join(VOXCPM_LAB, "models"), "--lab", lab, "--idle-minutes", "0.2"], { readyTimeoutMs: 300_000 });
        const client = await handle.client;
        try {
          expect(client.readyFrame.engine).toBe("voxcpm");
          // D2 真机锚：architecture=voxcpm2 分派的运行时类名与 TS 钉版 DAEMON_ENGINE_VERSION 同字面——
          // 若上游换类名，握手层会拒载降级（功能不坏），这里先让套件红出声告警
          expect(String(client.readyFrame.version)).toBe("VoxCPM2Model");
          expect(String(client.readyFrame.weights_fingerprint)).toBe(weightsFingerprint(lab, VOXCPM_WEIGHT_MARKERS));

          const frames = await client.request({ type: "synthesize", id: 1, text: "热启动验收，流式多帧的每个块都必须有能量。" }, 300_000);
          const last = frames[frames.length - 1]!;
          expect(last.type).toBe("audio");
          expect(last.done).toBe(true);
          const audios = frames.filter((f) => f.type === "audio");
          expect(audios.length, "流式形态应产出多帧（缓存协议尾块 done=true）").toBeGreaterThanOrEqual(1);
          for (const mid of audios.slice(0, -1)) expect(mid.done).toBe(false);
          const { pcm, sampleRate } = pcmFromFrames(audios);
          const verdict = assessPcm(pcm, sampleRate);
          expect(verdict.ok, `流式合成数值退化：${verdict.defect}（rms=${verdict.rms.toFixed(0)} dur=${verdict.durationS.toFixed(2)}s）`).toBe(true);
        } finally {
          client.close();
        }
        // idle 自收割真形态：不 kill、不发 shutdown，进程到阈自退 exit 0，日志留痕、注册点清净
        const exit = await handle.exit;
        expect(exit.code, `自收割应为优雅退出 exit 0（signal=${exit.signal}，log 尾=${readLog(lab).slice(-200)}）`).toBe(0);
        expect(readLog(lab)).toMatch(/自收割退出/);
        expect(existsSync(join(lab, "daemon.sock"))).toBe(false);
        expect(existsSync(join(lab, "daemon.pid"))).toBe(false);
      });
    },
    320_000,
  );

  it.skipIf(!VOXCPM_SYNTH)(
    "SIGKILL 注入残file：下一任 daemon unlink-rebind 真恢复，合成照常出声",
    async () => {
      await withTempLab(async (lab) => {
        const python = VOXCPM_VENV_PYTHON as string;
        const first = startDaemonShim(python, [VOXCPM_SHIM, "--daemon", "--models", join(VOXCPM_LAB, "models"), "--lab", lab], { readyTimeoutMs: 300_000 });
        const ready1 = await first.client;
        const pid = Number(ready1.readyFrame.pid);
        ready1.close();
        first.kill("SIGKILL"); // 硬杀：cleanup 不跑，sock/pid 残留挡路
        await first.exit;
        expect(existsSync(join(lab, "daemon.sock"))).toBe(true); // 残file 在场 = 本用例的前置事实

        const second = startDaemonShim(python, [VOXCPM_SHIM, "--daemon", "--models", join(VOXCPM_LAB, "models"), "--lab", lab], { readyTimeoutMs: 300_000 });
        const ready2 = await second.client;
        try {
          expect(Number(ready2.readyFrame.pid)).not.toBe(pid); // 真重 bind（新进程持有注册点）
          const frames = await ready2.request({ type: "synthesize", id: 1, text: "残file 顶掉后的第一条，必须出声。" }, 300_000);
          const { pcm, sampleRate } = pcmFromFrames(frames.filter((f) => f.type === "audio"));
          const verdict = assessPcm(pcm, sampleRate);
          expect(verdict.ok, `重 bind 后合成数值退化：${verdict.defect}`).toBe(true);
          expect(readLog(lab)).toMatch(/bind/); // 新 daemon 的 bind 留痕在案
        } finally {
          second.kill("SIGTERM");
          const exit = await second.exit;
          expect(exit.code, `SIGTERM 优雅退（log 尾=${readLog(lab).slice(-200)}）`).toBe(0);
        }
      });
    },
    320_000,
  );
});
