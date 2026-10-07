import { describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { startFakeDaemon } from "./daemon-fakes.ts";
import { DAEMON_QUEUE_FULL_MESSAGE } from "../src/engines/gptsovits-binding.ts";

/**
 * indextts shim 的 daemon 服务循环真实现场测试（热启动 S3，钉版照抄的 indextts 变体）。
 * 生命周期骨架（bind 先于加载、pid/log 落位、fatal 自退、探针判负 exit 3、残file顶替、
 * 有界队列拒转）与 gptsovits 钉版同构——本套件验的是「indextts 侧装配正确」：
 * 桩引擎按 IndexTTS2 形态（device 属性 + infer 返回 (sample_rate, wav)）替换真模型，
 * ready 帧的版本键三元组与 pid 自述、队满 message 源文本、--print-fingerprint 面。
 * 竞态与队列的仲裁语义本身由 gptsovits 侧套件钉死（共享骨架的回归锚在那边）。
 */

const SHIM = fileURLToPath(new URL("../scripts/shims/indextts-shim.py", import.meta.url));

/**
 * 假引擎桩：lab/index-tts/indextts 下的最小 IndexTTS2 替身（系统 python 有 numpy）。
 * infer 固定 sleep 0.4s 模拟单飞耗时——队列容量测试靠它制造「一个在途、四个排队」窗口；
 * 返回 Gradio 转置形态 int16 (samples, channels)，与真引擎的输出约定一致。
 */
function writeStubEngine(lab: string): void {
  const pkg = join(lab, "index-tts", "indextts");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "__init__.py"), "");
  writeFileSync(
    join(pkg, "infer_v2_5.py"),
    [
      "import time",
      "",
      "import numpy as np",
      "",
      "class IndexTTS2:",
      "    def __init__(self, cfg_path=None, model_dir=None):",
      "        self.device = 'cpu'",
      "",
      "    def infer(self, ref_audio_path, text, output_path, lang='zh', **kwargs):",
      "        time.sleep(0.4)",
      "        return 22050, np.zeros((8, 1), dtype=np.int16)",
      "",
    ].join("\n"),
  );
}

/**
 * 连上 daemon 读到 ready 帧即收——假引擎加载毫秒级，但解释器启动到 sock 落位有空窗：
 * ENOENT/ECONNREFUSED 重试到就绪或超时（同 gptsovits 侧判因）。
 */
async function waitReadyFrame(sockPath: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await onceReadyFrame(sockPath);
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await sleep(60);
    }
  }
}

/** 读首个 ready 帧原文；连上即收首行 JSON（空窗由外层 waitReadyFrame 同款重试环兜住） */
function readFirstFrame(sockPath: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sockPath);
    let buf = "";
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error("ready 帧超时"));
    }, 2000);
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const line = buf.split("\n").find((l) => l.trim().startsWith("{"));
      if (line !== undefined) {
        clearTimeout(timer);
        conn.destroy();
        resolve(JSON.parse(line) as Record<string, unknown>);
      }
    });
    conn.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function onceReadyFrame(sockPath: string): Promise<void> {
  return readFirstFrame(sockPath).then(() => undefined);
}

/** 单请求一连接：写 indextts 形态合成行，收首个 audio/error 终结帧 */
function driveOneRequest(sockPath: string, id: number, timeoutMs = 20_000): Promise<{ type: string; message?: string }> {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sockPath);
    let buf = "";
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error(`请求 ${id} 等待响应超时`));
    }, timeoutMs);
    conn.on("connect", () => {
      conn.write(`{"type":"synthesize","id":${id},"text":"竞态测试","ref_audio_path":"/r.wav","text_lang":"zh"}\n`);
    });
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (const line of buf.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || !trimmed.startsWith("{")) continue;
        let msg: { type?: string; message?: string };
        try {
          msg = JSON.parse(trimmed) as { type?: string; message?: string };
        } catch {
          continue;
        }
        if (msg.type === "audio" || msg.type === "error") {
          clearTimeout(timer);
          conn.destroy();
          resolve(msg.message !== undefined ? { type: msg.type, message: msg.message } : { type: msg.type });
          return;
        }
      }
    });
    conn.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function withTempLab(run: (lab: string) => Promise<void>): Promise<void> {
  const lab = mkdtempSync(join(tmpdir(), "say-idt-"));
  mkdirSync(join(lab, "index-tts"), { recursive: true }); // repo 目录形态与真机安装面一致
  return run(lab).finally(() => rmSync(lab, { recursive: true, force: true }));
}

function startShim(lab: string, extraArgs: readonly string[] = []) {
  const proc = spawn("python3", [SHIM, "--daemon", "--repo", join(lab, "index-tts"), "--models", join(lab, "checkpoints"), "--lab", lab, ...extraArgs], { stdio: "ignore" });
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal })));
  return { proc, exit };
}

describe("indextts shim --daemon 服务循环生命周期", () => {
  it("bind 先于加载：系统 python 缺引擎依赖 fatal 自退 exit 1，sock/pid 清净，日志留 bind→fatal 轨迹", async () => {
    await withTempLab(async (lab) => {
      const shim = startShim(lab);
      expect((await shim.exit).code).toBe(1);
      expect(existsSync(join(lab, "daemon.sock"))).toBe(false);
      expect(existsSync(join(lab, "daemon.pid"))).toBe(false);
      const log = readFileSync(join(lab, "daemon.log"), "utf8");
      expect(log).toContain("bind");
      expect(log).toContain("加载失败");
    });
  }, 30_000);

  it("已有活体 daemon：探针可连即判负 exit 3，不动赢家的 sock/pid", async () => {
    await withTempLab(async (lab) => {
      const sockPath = join(lab, "daemon.sock");
      const winner = await startFakeDaemon(sockPath);
      const shim = startShim(lab);
      try {
        expect((await shim.exit).code).toBe(3);
      } finally {
        expect(winner.connects).toBeGreaterThanOrEqual(1);
        expect(() => winner.close()).not.toThrow();
      }
    });
  }, 30_000);

  it("残file无人监听：判陈旧清掉重 bind，服务循环照常起（日志见加载失败而非 bind 异常）", async () => {
    await withTempLab(async (lab) => {
      const sockPath = join(lab, "daemon.sock");
      const binder = spawn("python3", [
        "-c",
        `import socket,os,time;s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
p=${JSON.stringify(sockPath)}
s.bind(p);s.listen(1);print("ok",flush=True);time.sleep(30)`,
      ]);
      await new Promise<void>((resolve) => binder.stdout!.once("data", () => resolve()));
      binder.kill("SIGKILL");
      await new Promise<void>((resolve) => binder.once("exit", () => resolve()));
      const shim = startShim(lab);
      expect((await shim.exit).code).toBe(1);
      expect(existsSync(sockPath)).toBe(false);
      const log = readFileSync(join(lab, "daemon.log"), "utf8");
      expect(log).toContain("bind");
      expect(log).toContain("加载失败");
    });
  }, 30_000);
});

describe("indextts shim --daemon 活体竞态、队列容量与版本键（假引擎桩）", () => {
  it("双 shim 并发 bind：后来者探针判负 exit 3，赢家 sock/pid 分毫未动", async () => {
    await withTempLab(async (lab) => {
      writeStubEngine(lab);
      const winner = startShim(lab);
      const sockPath = join(lab, "daemon.sock");
      try {
        await waitReadyFrame(sockPath);
        const pidBefore = readFileSync(join(lab, "daemon.pid"), "utf8");
        const loser = startShim(lab);
        expect((await loser.exit).code).toBe(3);
        expect(readFileSync(join(lab, "daemon.pid"), "utf8")).toBe(pidBefore);
        expect(existsSync(sockPath)).toBe(true);
        loser.proc.kill("SIGKILL");
      } finally {
        winner.proc.kill("SIGTERM");
        expect((await winner.exit).code).toBe(0);
      }
    });
  }, 60_000);

  it("队列容量上限 4：六路请求恰一路收拒转 error 帧（message 前缀即契约串），其余五路全出声", async () => {
    await withTempLab(async (lab) => {
      writeStubEngine(lab);
      const shim = startShim(lab);
      const sockPath = join(lab, "daemon.sock");
      try {
        await waitReadyFrame(sockPath);
        const first = driveOneRequest(sockPath, 0);
        await sleep(120);
        const rest = await Promise.all([1, 2, 3, 4, 5].map((i) => driveOneRequest(sockPath, i)));
        const results = [await first, ...rest];
        const rejects = results.filter((r) => r.type === "error" && (r.message ?? "").startsWith(DAEMON_QUEUE_FULL_MESSAGE));
        const audios = results.filter((r) => r.type === "audio");
        expect(rejects).toHaveLength(1); // 6 = 1 在途 + 4 排队 + 1 拒
        expect(audios).toHaveLength(5);
        expect(results.filter((r) => r.type === "error" && !(r.message ?? "").startsWith(DAEMON_QUEUE_FULL_MESSAGE))).toHaveLength(0);
      } finally {
        shim.proc.kill("SIGTERM");
        await shim.exit;
      }
    });
  }, 90_000);

  it("ready 帧携带握手版本键三元组与 pid 自述（indextts 侧：protocol=2 / engine=indextts / version=2.5 / 64hex 指纹 / pid>0）", async () => {
    await withTempLab(async (lab) => {
      writeStubEngine(lab);
      const shim = startShim(lab);
      const sockPath = join(lab, "daemon.sock");
      try {
        const frame = await (async () => {
          const deadline = Date.now() + 15_000;
          for (;;) {
            try {
              return await readFirstFrame(sockPath);
            } catch (error) {
              if (Date.now() >= deadline) throw error;
              await sleep(60);
            }
          }
        })();
        expect(frame.type).toBe("ready");
        expect(frame.engine).toBe("indextts");
        expect(frame.version).toBe("2.5");
        expect(frame.protocol).toBe("2");
        expect(String(frame.weights_fingerprint)).toMatch(/^[0-9a-f]{64}$/);
        expect(typeof frame.pid).toBe("number");
        expect(Number(frame.pid)).toBeGreaterThan(0);
        expect(String(frame.device)).toBe("cpu"); // 桩引擎自述 device，字段面沿用 per-call
      } finally {
        shim.proc.kill("SIGTERM");
        await shim.exit;
      }
    });
  }, 60_000);

  it("队满拒转 message 跨语言对拍：indextts shim 源内常量与 TS 消费侧逐字一致", () => {
    const py = readFileSync(SHIM, "utf8");
    const m = /QUEUE_FULL_MESSAGE = "([^"]+)"/.exec(py);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe(DAEMON_QUEUE_FULL_MESSAGE);
  });

  it("--print-fingerprint 独立可跑：不触引擎 import，产出 64hex（空投影清单也是合法指纹）", () => {
    const lab = mkdtempSync(join(tmpdir(), "say-idt-fp-"));
    try {
      const out = execFileSync("python3", [SHIM, "--print-fingerprint", "--repo", join(lab, "index-tts")], { encoding: "utf8" });
      expect(out.trim()).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(lab, { recursive: true, force: true });
    }
  });
});
