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
import { DAEMON_ENGINE_VERSION, DAEMON_PROTOCOL_VERSION } from "../src/engines/voxcpm-binding.ts";
import { BUILTIN_DAEMON_IDLE } from "../src/config.ts";

/**
 * voxcpm shim 的 daemon 服务循环真实现场测试（热启动 S5 voxcpm 链，gptsovits 钉版同构复制）。
 * 生命周期骨架与 firered/indextts 套件同面（bind 先于加载、探针判负 exit 3、残file重 bind、
 * 竞态、队列 4 拒转、版本键三元组）——本套件独有的承重面是**流式多帧**：
 * daemon 的 process_request 把 generate_streaming 的块序列逐帧写回同一连接
 * （缓存上一块 → done=false 中间帧、尾块 done=true、零块 error），
 * 这是四引擎 daemon 化里唯一的流式形态，帧序语义在这里钉死。
 * 桩引擎经 PYTHONPATH 注入 voxcpm 包替身（类名 VoxCPM2Model 镜像真实 ready.version 面；
 * inference_timesteps 复用为块数旋钮——桩按 shim 透传的 kwargs 建模，不改 shim 语义）。
 */

const SHIM = fileURLToPath(new URL("../scripts/shims/voxcpm-shim.py", import.meta.url));

/**
 * 假引擎桩：lab/site/voxcpm.py（from voxcpm import VoxCPM 的替身位）。
 * generate_streaming 每块 sleep 0.4s 模拟单飞在途耗时——队列容量测试靠它制造
 * 「一个在途、四个排队」窗口；inference_timesteps 决定块数（0 = 零块流 error 形态）。
 * tts_model 类名直接叫 VoxCPM2Model：ready.version 走运行时类名，桩镜像真机字面。
 */
function writeStubEngine(lab: string): void {
  const site = join(lab, "site");
  mkdirSync(site, { recursive: true });
  writeFileSync(
    join(site, "voxcpm.py"),
    [
      "import time",
      "",
      "import numpy as np",
      "",
      "class _Param:",
      "    device = 'cpu'",
      "",
      "class VoxCPM2Model:",
      "    sample_rate = 24000",
      "",
      "    def parameters(self):",
      "        return iter([_Param()])",
      "",
      "class VoxCPM:",
      "    def __init__(self):",
      "        self.tts_model = VoxCPM2Model()",
      "",
      "    @classmethod",
      "    def from_pretrained(cls, path, load_denoiser=False, optimize=True, device=None):",
      "        time.sleep(0.2)",
      "        return cls()",
      "",
      "    def generate_streaming(self, text, **kwargs):",
      "        for _ in range(int(kwargs.get('inference_timesteps', 3))):",
      "            time.sleep(0.4)",
      "            yield np.zeros(8, dtype=np.float32)",
      "",
    ].join("\n"),
  );
  mkdirSync(join(lab, "models"), { recursive: true }); // from_pretrained 的目录位（桩不校验内容）
}

/** 启动 daemon：stub=false 时不注入桩（系统 python3 无 voxcpm 包 → 加载 fatal 形态） */
function startShim(lab: string, extraArgs: readonly string[] = [], stub = true) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (stub) env.PYTHONPATH = join(lab, "site");
  const proc = spawn("python3", [SHIM, "--daemon", "--models", join(lab, "models"), "--lab", lab, ...extraArgs], { stdio: "ignore", env });
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal })));
  return { proc, exit };
}

/** 连上 daemon 读到首帧即弃——就绪探测（ENOENT/ECONNREFUSED 重试环兜住解释器启动空窗） */
async function waitReadyFrame(sockPath: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const frame = await readFirstFrame(sockPath);
      if (frame.type === "ready") return;
      throw new Error(`首帧不是 ready: ${JSON.stringify(frame)}`);
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await sleep(60);
    }
  }
}

function readFirstFrame(sockPath: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sockPath);
    let buf = "";
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error("ready 帧超时"));
    }, 3000);
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

/**
 * 单请求一连接：写合成行，收完整响应帧序列（done 帧或 error 帧终结）。
 * 流式形态的观测面 = 帧序本身：中间帧 done=false、尾帧 done=true 或 error。
 */
function driveStreamingRequest(sockPath: string, id: number, timeoutMs = 20_000): Promise<{ type: string; done?: boolean; message?: string; sample_rate?: number }[]> {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sockPath);
    const frames: { type: string; done?: boolean; message?: string; sample_rate?: number }[] = [];
    let buf = "";
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error(`请求 ${id} 等待响应帧超时`));
    }, timeoutMs);
    conn.on("connect", () => {
      conn.write(`{"type":"synthesize","id":${id},"text":"流式帧序测试"}\n`);
    });
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      // 逐行消费并从 buf 移除（多帧收集不重复计数；loopback 分包/并包都走这条线切分）
      let cut = buf.indexOf("\n");
      while (cut >= 0) {
        const line = buf.slice(0, cut).trim();
        buf = buf.slice(cut + 1);
        cut = buf.indexOf("\n");
        if (line.length === 0 || !line.startsWith("{")) continue;
        let msg: { type?: string; done?: boolean; message?: string; sample_rate?: number };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          continue;
        }
        if (msg.type === "audio" || msg.type === "error") {
          frames.push({ type: msg.type, ...(msg.done !== undefined ? { done: msg.done } : {}), ...(msg.message !== undefined ? { message: msg.message } : {}), ...(msg.sample_rate !== undefined ? { sample_rate: msg.sample_rate } : {}) });
        }
        const last = frames[frames.length - 1];
        if (last !== undefined && (last.type === "error" || last.done === true)) {
          clearTimeout(timer);
          conn.destroy();
          resolve(frames);
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
  const lab = mkdtempSync(join(tmpdir(), "say-vxcd-"));
  return run(lab).finally(() => rmSync(lab, { recursive: true, force: true }));
}

describe("voxcpm shim --daemon 服务循环生命周期", () => {
  it("bind 先于加载：无桩注入时引擎 import 失败 fatal 自退 exit 1，sock/pid 清净，日志留 bind→fatal 轨迹", async () => {
    await withTempLab(async (lab) => {
      mkdirSync(join(lab, "models"), { recursive: true });
      const shim = startShim(lab, [], false);
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
      const shim = startShim(lab, [], false); // 判负发生在加载前，桩都不需要
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
      mkdirSync(join(lab, "models"), { recursive: true });
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
      const shim = startShim(lab, [], false);
      expect((await shim.exit).code).toBe(1);
      expect(existsSync(sockPath)).toBe(false);
      const log = readFileSync(join(lab, "daemon.log"), "utf8");
      expect(log).toContain("bind");
      expect(log).toContain("加载失败");
    });
  }, 30_000);
});

describe("voxcpm shim --daemon 竞态、队列与版本键（假引擎桩）", () => {
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
      const shim = startShim(lab, ["--timesteps", "2"]); // 单请求在途 ~0.8s：排队窗口清晰
      const sockPath = join(lab, "daemon.sock");
      try {
        await waitReadyFrame(sockPath);
        const first = driveStreamingRequest(sockPath, 0);
        await sleep(150);
        const rest = await Promise.all([1, 2, 3, 4, 5].map((i) => driveStreamingRequest(sockPath, i)));
        const results = [await first, ...rest];
        const rejects = results.filter((frames) => frames.some((f) => f.type === "error" && (f.message ?? "").startsWith(DAEMON_QUEUE_FULL_MESSAGE)));
        const audios = results.filter((frames) => frames.some((f) => f.type === "audio" && f.done === true));
        expect(rejects).toHaveLength(1); // 6 = 1 在途 + 4 排队 + 1 拒
        expect(audios).toHaveLength(5);
      } finally {
        shim.proc.kill("SIGTERM");
        await shim.exit;
      }
    });
  }, 90_000);

  it("ready 帧携带握手版本键三元组与 pid 自述（voxcpm 侧：protocol=2 / engine=voxcpm / version=运行时类名 / 64hex 指纹 / pid>0）", async () => {
    await withTempLab(async (lab) => {
      writeStubEngine(lab);
      const shim = startShim(lab);
      const sockPath = join(lab, "daemon.sock");
      try {
        const frame = await (async () => {
          const deadline = Date.now() + 20_000;
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
        expect(frame.engine).toBe("voxcpm");
        expect(frame.version).toBe(DAEMON_ENGINE_VERSION); // 桩类名镜像真机 architecture=voxcpm2 的运行时类名；与 binding 常量对拍
        expect(frame.protocol).toBe(DAEMON_PROTOCOL_VERSION);
        expect(String(frame.weights_fingerprint)).toMatch(/^[0-9a-f]{64}$/);
        expect(typeof frame.pid).toBe("number");
        expect(Number(frame.pid)).toBeGreaterThan(0);
        expect(String(frame.device)).toBe("cpu"); // 桩自述 device，字段面沿用 per-call
      } finally {
        shim.proc.kill("SIGTERM");
        await shim.exit;
      }
    });
  }, 60_000);
});

describe("voxcpm shim --daemon 流式多帧语义（四引擎 daemon 化的唯一流式面）", () => {
  it("三块流：前两块 done=false 中间帧、尾块 done=true，sample_rate 恒 24000", async () => {
    await withTempLab(async (lab) => {
      writeStubEngine(lab);
      const shim = startShim(lab, ["--timesteps", "3"]);
      const sockPath = join(lab, "daemon.sock");
      try {
        await waitReadyFrame(sockPath);
        const frames = await driveStreamingRequest(sockPath, 1);
        expect(frames.map((f) => f.done)).toEqual([false, false, true]);
        expect(frames.every((f) => f.type === "audio" && f.sample_rate === 24000)).toBe(true);
      } finally {
        shim.proc.kill("SIGTERM");
        await shim.exit;
      }
    });
  }, 60_000);

  it("单块流压缩为一帧 done=true（缓存协议的既有钉版语义）", async () => {
    await withTempLab(async (lab) => {
      writeStubEngine(lab);
      const shim = startShim(lab, ["--timesteps", "1"]);
      const sockPath = join(lab, "daemon.sock");
      try {
        await waitReadyFrame(sockPath);
        const frames = await driveStreamingRequest(sockPath, 2);
        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({ type: "audio", done: true });
      } finally {
        shim.proc.kill("SIGTERM");
        await shim.exit;
      }
    });
  }, 60_000);

  it("零块流按 error 帧回报原文案（engine produced no audio），daemon 与连接都不动", async () => {
    await withTempLab(async (lab) => {
      writeStubEngine(lab);
      const shim = startShim(lab, ["--timesteps", "0"]);
      const sockPath = join(lab, "daemon.sock");
      try {
        await waitReadyFrame(sockPath);
        const frames = await driveStreamingRequest(sockPath, 3);
        expect(frames).toHaveLength(1);
        expect(frames[0]!.type).toBe("error");
        expect(frames[0]!.message).toBe("engine produced no audio");
      } finally {
        shim.proc.kill("SIGTERM");
        await shim.exit;
      }
    });
  }, 60_000);

  it("客户端中流离场：worker 中止生成（日志帧数不足总块数），单飞位随即服务后续请求", async () => {
    await withTempLab(async (lab) => {
      writeStubEngine(lab);
      const shim = startShim(lab, ["--timesteps", "5"]); // 5 块 × 0.4s：中止窗口清晰
      const sockPath = join(lab, "daemon.sock");
      try {
        await waitReadyFrame(sockPath);
        // 首帧到达即关连接：客户端 close 后 daemon 下一次跨块间隔的 sendall 吃 EPIPE → 中止
        await new Promise<void>((resolve, reject) => {
          const conn = net.connect(sockPath);
          const timer = setTimeout(() => {
            conn.destroy();
            reject(new Error("中流断连：首帧未到达"));
          }, 15_000);
          conn.on("connect", () => {
            conn.write(`{"type":"synthesize","id":40,"text":"中流离场"}\n`);
          });
          conn.on("data", (chunk) => {
            if (chunk.toString("utf8").includes('"type": "audio"') || chunk.toString("utf8").includes('"type":"audio"')) {
              clearTimeout(timer);
              conn.destroy(); // 客户端离场：daemon 对死连接的后续帧必须感知并停烧
              resolve();
            }
          });
          conn.on("error", () => undefined);
        });
        // 中止留痕落在 daemon.log（帧数 < 5 = 未烧完整句；EPIPE 时点由内核缓冲决定，1-4 皆合法）
        const deadline = Date.now() + 8_000;
        for (;;) {
          const log = readFileSync(join(lab, "daemon.log"), "utf8");
          const m = /请求 40 对端离场：(\d+) 帧后中止生成/.exec(log);
          if (m !== null) {
            expect(Number(m[1])).toBeLessThan(5);
            break;
          }
          if (Date.now() >= deadline) throw new Error("daemon.log 未出现中流中止记录：send 失败未触发 worker 停烧");
          await sleep(100);
        }
        // 单飞位已让出：新请求照常走完整帧序
        const frames = await driveStreamingRequest(sockPath, 41);
        expect(frames.filter((f) => f.type === "audio")).toHaveLength(5);
        expect(frames[frames.length - 1]!.done).toBe(true);
      } finally {
        shim.proc.kill("SIGTERM");
        await shim.exit;
      }
    });
  }, 60_000);
});

describe("voxcpm shim per-call 形态真执行（与 daemon 共享 stream_pcm 本体的同一张网）", () => {
  /** 真起 python 子进程走 stdin/stdout 管道：daemon 套件重写主循环后 per-call 面的回归网（审查 F3） */
  function drivePerCall(lab: string, timesteps: number, id: number): Promise<{ ready: Record<string, unknown>; frames: { type: string; done?: boolean; message?: string }[] }> {
    return new Promise((resolve, reject) => {
      const env: Record<string, string> = { ...(process.env as Record<string, string>), PYTHONPATH: join(lab, "site") };
      const proc = spawn("python3", [SHIM, "--models", join(lab, "models"), "--timesteps", String(timesteps)], { env, stdio: ["pipe", "pipe", "ignore"] });
      const ready: Record<string, unknown>[] = [];
      const frames: { type: string; done?: boolean; message?: string }[] = [];
      let buf = "";
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`per-call 形态超时（timesteps=${timesteps}）`));
      }, 25_000);
      const finish = () => {
        clearTimeout(timer);
        try {
          proc.stdin!.write('{"type":"shutdown"}\n');
          proc.stdin!.end();
        } catch {
          proc.kill();
        }
        void proc.once("exit", () => resolve({ ready: ready[0]!, frames }));
      };
      proc.stdout!.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let cut = buf.indexOf("\n");
        while (cut >= 0) {
          const line = buf.slice(0, cut).trim();
          buf = buf.slice(cut + 1);
          cut = buf.indexOf("\n");
          if (!line.startsWith("{")) continue;
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.type === "ready") {
            ready.push(msg);
            proc.stdin!.write(`{"type":"synthesize","id":${id},"text":"per-call 帧序对拍"}\n`);
            continue;
          }
          if (msg.type === "audio" || msg.type === "error") {
            frames.push({ type: String(msg.type), ...(msg.done !== undefined ? { done: msg.done as boolean } : {}), ...(msg.message !== undefined ? { message: String(msg.message) } : {}) });
            if (msg.type === "error" || msg.done === true) {
              finish();
              return;
            }
          }
        }
      });
      proc.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  it("三块流：ready 握手字段面（per-call 不带版本键，钉版差异）+ [false,false,true] 帧序与 daemon 逐字同构", async () => {
    await withTempLab(async (lab) => {
      writeStubEngine(lab);
      const out = await drivePerCall(lab, 3, 1);
      expect(out.ready).toMatchObject({ type: "ready", engine: "voxcpm", version: DAEMON_ENGINE_VERSION, device: "cpu" });
      expect(out.ready.protocol).toBeUndefined(); // per-call 传输层握手版本键缺省是既有钉版（daemon 独有）
      expect(out.ready.weights_fingerprint).toBeUndefined();
      expect(out.frames.map((f) => f.done)).toEqual([false, false, true]);
    });
  }, 40_000);

  it("零块流：error 帧原文案与 daemon 侧逐字一致（共享 NoAudioError 收敛路径）", async () => {
    await withTempLab(async (lab) => {
      writeStubEngine(lab);
      const out = await drivePerCall(lab, 0, 2);
      expect(out.frames).toHaveLength(1);
      expect(out.frames[0]).toMatchObject({ type: "error", message: "engine produced no audio" });
    });
  }, 40_000);
});

describe("voxcpm shim 协议面与 CLI 契约", () => {
  it("队满拒转 message 跨语言对拍：voxcpm shim 源内常量与 TS 消费侧逐字一致", () => {
    const py = readFileSync(SHIM, "utf8");
    const m = /QUEUE_FULL_MESSAGE = "([^"]+)"/.exec(py);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe(DAEMON_QUEUE_FULL_MESSAGE);
  });

  it("idle 收割缺省档跨语言对拍：shim --idle-minutes 缺省字面量 = config 内置表（手动拉起 daemon 与产品面档位不许静默分叉）", () => {
    const py = readFileSync(SHIM, "utf8");
    const m = /--idle-minutes", type=float, default=([\d.]+)/.exec(py);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBe(BUILTIN_DAEMON_IDLE.voxcpm);
  });

  it("--print-fingerprint 免引擎依赖：无 --lab 时按 --models 父目录推导 lab 投影，产出 64hex", () => {
    const lab = mkdtempSync(join(tmpdir(), "say-vxcd-fp-"));
    try {
      const out = execFileSync("python3", [SHIM, "--print-fingerprint", "--models", join(lab, "models")], { encoding: "utf8" });
      expect(out.trim()).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(lab, { recursive: true, force: true });
    }
  });
});
