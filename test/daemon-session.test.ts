import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { DaemonSession, DaemonUnavailableError, type DaemonSessionOptions } from "../src/engines/daemon-session.ts";
import type { DaemonProcess } from "../src/host.ts";

/**
 * daemon-session 的 fake 矩阵：测试内的假 daemon 是**进程内真 unix socket 服务端**（net.createServer），
 * 帧协议、分块边界、EOF 时序都走真 socket 传输——fake-host 的管道替身对 EOF/exit
 * 空窗与断连时序结构性失明，传输面只能实测。
 * kill 断言用真实短命子进程收 SIGKILL，验证 pid 文件链路；spawn 编排用可编程假 DaemonProcess。
 */

const VALID_KEY = { protocol: "2", engineVersion: "v2", weightsFingerprint: "fp-current" };

function readyFrame(over: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    type: "ready",
    engine: "gptsovits",
    version: "v2",
    device: "cpu",
    protocol: "2",
    weights_fingerprint: "fp-current",
    ...over,
  })}\n`;
}

const REQUEST_LINE = '{"type":"synthesize","id":1,"text":"你好"}\n';

/** 假 daemon 服务端：每个连接建立即写 ready（可注入杂散行前置/坏版本键/hang 形态/请求后断连） */
interface FakeDaemonSpec {
  ready?: string | "none";
  beforeReady?: string[];
  /** 收到请求行后的行为：缺省回 audio done；"close" 立即断连（在途 EOF）；"ignore" 挂死（hang） */
  onLine?: "audio" | "close" | "ignore";
  /** 按给定字节块序写帧（模拟 TCP 分包在 UTF-8 多字节中间切断） */
  writeChunks?: Buffer[];
}

interface FakeDaemon {
  connects: number;
  requests: string[];
  close(): Promise<void>;
}

function startFakeDaemon(sockPath: string, spec: FakeDaemonSpec = {}): Promise<FakeDaemon> {
  const sockets: net.Socket[] = [];
  const requests: string[] = [];
  let connects = 0;
  try {
    unlinkSync(sockPath);
  } catch {
    /* 残file不存在属正常 */
  }
  const server = net.createServer((conn) => {
    connects += 1;
    sockets.push(conn);
    conn.setNoDelay(true);
    if (spec.writeChunks !== undefined) {
      // 分块写：逐块回调拉开间隔，loopback 不合并、退化为独立 chunk
      let i = 0;
      const step = () => {
        if (i < spec.writeChunks!.length) conn.write(spec.writeChunks![i++]!, step);
      };
      step();
    } else {
      for (const noise of spec.beforeReady ?? []) conn.write(noise);
      if (spec.ready !== "none") conn.write(spec.ready ?? readyFrame());
    }
    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let cut = buffer.indexOf("\n");
      while (cut >= 0) {
        const line = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 1);
        if (line.length > 0) {
          requests.push(line);
          if (spec.onLine === "close") {
            conn.end(); // 请求刚收到就掐连接：在途 EOF 形态
            return;
          }
          if (spec.onLine !== "ignore") {
            const id = (JSON.parse(line) as { id: number }).id;
            const pcm = Buffer.alloc(4);
            pcm.writeInt16LE(16384, 0);
            pcm.writeInt16LE(-16384, 2);
            conn.write(`${JSON.stringify({ type: "audio", id, pcm: pcm.toString("base64"), sample_rate: 32000, done: true })}\n`);
          }
        }
        cut = buffer.indexOf("\n");
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(sockPath, () =>
      resolve({
        get connects() {
          return connects;
        },
        requests,
        close: () =>
          new Promise<void>((res) => {
            for (const s of sockets) s.destroy();
            server.close(() => res());
          }),
      }),
    );
    server.on("error", reject);
  });
}

/** 可编程假 DaemonProcess：exit 由测试驱动；pid 指向不存在进程，kill 路径 ESRCH 应被吞 */
function fakeProc(): DaemonProcess & { settle(code: number | null, signal: string | null): void } {
  let settle: (o: { exitCode: number | null; signal: string | null }) => void = () => undefined;
  const exit = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
    settle = resolve;
  });
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 999999999,
    exit,
    settle: (code, signal) => settle({ exitCode: code, signal }),
  };
}

/** 真实短命 dummy：pid 文件写它的号，kill 链路断言收到 SIGKILL */
async function makeLiveDummy(pidPath: string): Promise<{ expectKilled(): Promise<string | null> }> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  child.unref();
  await sleep(50);
  if (child.exitCode !== null) throw new Error("dummy 子进程秒退，测试前提不成立");
  writeFileSync(pidPath, `${child.pid}\n`);
  const signal = new Promise<string | null>((resolve) => child.once("exit", (_code, sig) => resolve(sig)));
  return { expectKilled: () => signal };
}

class Harness {
  readonly dir: string;
  readonly sockPath: string;
  readonly pidPath: string;
  readonly spawns: Array<{ idleMinutes: number; proc: ReturnType<typeof fakeProc> }> = [];
  readonly daemons: FakeDaemon[] = [];
  /** spawn 副作用队列：每次 spawn 依序消费（模拟真 shim 拉起后 bind sock 起服务） */
  spawnHooks: Array<(proc: ReturnType<typeof fakeProc>) => void> = [];
  session: DaemonSession;

  constructor(over: Partial<DaemonSessionOptions> = {}) {
    this.dir = mkdtempSync(join(tmpdir(), "say-dmn-"));
    this.sockPath = join(this.dir, "daemon.sock");
    this.pidPath = join(this.dir, "daemon.pid");
    const opts: DaemonSessionOptions = {
      label: "GPT-SoVITS",
      socketPath: this.sockPath,
      pidPath: this.pidPath,
      idleMinutes: 15,
      spawn: (idleMinutes) => {
        const proc = fakeProc();
        this.spawns.push({ idleMinutes, proc });
        this.spawnHooks.shift()?.(proc);
        return proc;
      },
      expectedVersionKey: () => VALID_KEY,
      readyTimeoutMs: 1500,
      warmTimeoutMs: 300,
      requestTimeoutMs: 300,
      pollIntervalMs: 20,
      ...over,
    };
    this.session = new DaemonSession(opts);
  }

  track(daemon: FakeDaemon): FakeDaemon {
    this.daemons.push(daemon);
    return daemon;
  }

  async cleanup(): Promise<void> {
    this.session.close();
    for (const d of this.daemons) await d.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

async function collectRequest(session: DaemonSession, line = REQUEST_LINE): Promise<string[]> {
  const frames: string[] = [];
  for await (const raw of session.request(line)) {
    frames.push(raw);
    if ((JSON.parse(raw) as { done?: boolean }).done === true) break; // 终结帧交付即收束（早退归还 idle unref）
  }
  return frames;
}

describe("DaemonSession.ensure：warm 直连与 handshake", () => {
  it("既有 daemon 在位：connect + ready 三元组校验通过，不触发 spawn", async () => {
    const h = new Harness();
    try {
      h.track(await startFakeDaemon(h.sockPath));
      await h.session.ensure();
      expect(h.spawns).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });

  it("ready 前的引擎杂散行被丢弃不毒化握手", async () => {
    const h = new Harness();
    try {
      h.track(await startFakeDaemon(h.sockPath, { beforeReady: ["并行推理模式已开启\n", "0.412\t0.031\n"] }));
      await h.session.ensure();
    } finally {
      await h.cleanup();
    }
  });

  it("分包在 UTF-8 多字节中间切断：行读取按 Buffer 累积重组，帧完整可解析", async () => {
    const h = new Harness();
    try {
      const noise = Buffer.from("并行推理模式已开启\n");
      const ready = Buffer.from(readyFrame());
      // 在「推」字的三字节序列中间切一刀（偏移 7 落在 3 字节字符的第二字节后）
      const cut = 7;
      h.track(
        await startFakeDaemon(h.sockPath, {
          writeChunks: [noise.subarray(0, cut), noise.subarray(cut), ready.subarray(0, 20), ready.subarray(20)],
        }),
      );
      await h.session.ensure();
      const frames = await collectRequest(h.session);
      expect(frames).toHaveLength(1);
      expect((JSON.parse(frames[0]!) as { type: string }).type).toBe("audio");
    } finally {
      await h.cleanup();
    }
  });

  it("协议版本不符：SIGKILL 过期 daemon（pid 文件链路）+ unlink sock + 重拉一次成功", async () => {
    const h = new Harness();
    try {
      const dummy = await makeLiveDummy(h.pidPath);
      h.track(await startFakeDaemon(h.sockPath, { ready: readyFrame({ protocol: "1" }) }));
      h.spawnHooks.push(() => {
        void startFakeDaemon(h.sockPath, { ready: readyFrame() }).then((d) => h.track(d));
      });
      await h.session.ensure();
      expect(h.spawns).toHaveLength(1);
      expect(await dummy.expectKilled()).toBe("SIGKILL");
    } finally {
      await h.cleanup();
    }
  });

  it("权重指纹不符：同一路径 kill 重拉（过期权重 daemon 产错音频不可接受）", async () => {
    const h = new Harness();
    try {
      h.track(await startFakeDaemon(h.sockPath, { ready: readyFrame({ weights_fingerprint: "fp-stale" }) }));
      h.spawnHooks.push(() => {
        void startFakeDaemon(h.sockPath).then((d) => h.track(d));
      });
      await h.session.ensure();
      expect(h.spawns).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });

  it("重拉后握手仍不符：判 unavailable，不再无限重拉（重拉封顶语义）", async () => {
    const h = new Harness();
    try {
      h.track(await startFakeDaemon(h.sockPath, { ready: readyFrame({ version: "v9" }) }));
      h.spawnHooks.push(() => {
        void startFakeDaemon(h.sockPath, { ready: readyFrame({ version: "v9" }) }).then((d) => h.track(d));
      });
      await expect(h.session.ensure()).rejects.toBeInstanceOf(DaemonUnavailableError);
      expect(h.spawns).toHaveLength(1);
      // sticky：再次 ensure 不再拉起
      await expect(h.session.ensure()).rejects.toBeInstanceOf(DaemonUnavailableError);
      expect(h.spawns).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });

  it("握手收到 fatal 帧：确定性加载失败不重拉，直接 unavailable 交 per-call 报精确原因", async () => {
    const h = new Harness();
    try {
      h.track(await startFakeDaemon(h.sockPath, { ready: '{"type":"fatal","message":"权重缺失: s2G2333k.pth"}\n' }));
      await expect(h.session.ensure()).rejects.toThrow(/权重缺失|unavailable/i);
      expect(h.spawns).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });

  it("连上但 ready 超时（僵死 daemon）：kill 重拉一次", async () => {
    const h = new Harness({ warmTimeoutMs: 120 });
    try {
      const dummy = await makeLiveDummy(h.pidPath);
      h.track(await startFakeDaemon(h.sockPath, { ready: "none" }));
      h.spawnHooks.push(() => {
        void startFakeDaemon(h.sockPath).then((d) => h.track(d));
      });
      await h.session.ensure();
      expect(await dummy.expectKilled()).toBe("SIGKILL");
      expect(h.spawns).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });

  it("sock 文件在但无人监听（僵死残file ECONNREFUSED）：unlink 后转 lazy 拉起", async () => {
    const h = new Harness();
    try {
      // 真僵死 sock：python 绑定后 SIGKILL，残留 socket 文件无人监听
      const binder = spawn("python3", [
        "-c",
        `import socket,os;s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
p=${JSON.stringify(h.sockPath)}
try: os.remove(p)
except OSError: pass
s.bind(p);s.listen(1);print("ok",flush=True);import time;time.sleep(30)`,
      ]);
      await new Promise<void>((resolve) => binder.stdout!.once("data", () => resolve()));
      binder.kill("SIGKILL");
      await new Promise<void>((resolve) => binder.once("exit", () => resolve()));
      h.spawnHooks.push(() => {
        void startFakeDaemon(h.sockPath).then((d) => h.track(d));
      });
      await h.session.ensure();
      expect(h.spawns).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });
});

describe("DaemonSession.ensure：lazy 拉起编排", () => {
  it("sock 缺席：spawn --daemon 后轮询到可连，ready 校验通过", async () => {
    const h = new Harness({ idleMinutes: 15 });
    try {
      h.spawnHooks.push(() => {
        void sleep(60).then(async () => {
          const d = await startFakeDaemon(h.sockPath);
          h.track(d);
        });
      });
      await h.session.ensure();
      expect(h.spawns).toHaveLength(1);
      expect(h.spawns[0]!.idleMinutes).toBe(15);
    } finally {
      await h.cleanup();
    }
  });

  it("spawn 后进程即退（解释器/权重缺失）：按拉起失败收敛，不无限等 ready", async () => {
    const h = new Harness();
    try {
      h.spawnHooks.push((proc) => setTimeout(() => proc.settle(1, null), 30));
      await expect(h.session.ensure()).rejects.toBeInstanceOf(DaemonUnavailableError);
    } finally {
      await h.cleanup();
    }
  });

  it("拉起后 ready 迟迟不到（加载超时）：杀自己拉起的进程并判 unavailable", async () => {
    const h = new Harness({ readyTimeoutMs: 200 });
    try {
      h.spawnHooks.push(() => {
        void startFakeDaemon(h.sockPath, { ready: "none" }).then((d) => h.track(d));
      });
      await expect(h.session.ensure()).rejects.toBeInstanceOf(DaemonUnavailableError);
      // 第二次 ensure（重拉）仍 hang → 超时上限即封顶
      expect(h.spawns.length).toBeGreaterThanOrEqual(1);
    } finally {
      await h.cleanup();
    }
  });
});

describe("DaemonSession.request：在途传输与失败收敛", () => {
  it("请求往返：audio done 帧经 generator 交付；两次请求复用同一连接（不再握手）", async () => {
    const h = new Harness();
    try {
      const daemon = h.track(await startFakeDaemon(h.sockPath));
      const framesA = await collectRequest(h.session);
      const framesB = await collectRequest(h.session, '{"type":"synthesize","id":2,"text":"第二句"}\n');
      expect(framesA).toHaveLength(1);
      expect(framesB).toHaveLength(1);
      expect(daemon.requests).toHaveLength(2);
      expect(daemon.connects).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  it("在途 daemon 断连（EOF）：抛 DaemonUnavailableError 且转 sticky，交调用方降级", async () => {
    const h = new Harness();
    try {
      h.track(await startFakeDaemon(h.sockPath, { onLine: "close" }));
      await expect(collectRequest(h.session)).rejects.toBeInstanceOf(DaemonUnavailableError);
      // 后续请求不再触 socket：sticky 直拒
      await expect(h.session.ensure()).rejects.toBeInstanceOf(DaemonUnavailableError);
    } finally {
      await h.cleanup();
    }
  });

  it("在途 hang（请求超时）：kill daemon（pid 文件链路）+ 抛 unavailable", async () => {
    const h = new Harness({ requestTimeoutMs: 150 });
    try {
      const dummy = await makeLiveDummy(h.pidPath);
      h.track(await startFakeDaemon(h.sockPath, { onLine: "ignore" }));
      await expect(collectRequest(h.session)).rejects.toBeInstanceOf(DaemonUnavailableError);
      expect(await dummy.expectKilled()).toBe("SIGKILL");
    } finally {
      await h.cleanup();
    }
  });
});
