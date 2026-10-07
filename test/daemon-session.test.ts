import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { DaemonSession, DaemonUnavailableError, type DaemonSessionOptions } from "../src/engines/daemon-session.ts";
import type { DaemonProcess } from "../src/host.ts";
import { readyFrame, startFakeDaemon, type FakeDaemon } from "./daemon-fakes.ts";

/**
 * daemon-session 的 fake 矩阵（共享替身见 daemon-fakes.ts）：假 daemon 是进程内真 unix socket
 * 服务端，传输面实测。kill 断言用真实短命子进程收 SIGKILL，验证 pid 文件链路；
 * spawn 编排用可编程假 DaemonProcess。
 */

/** 与 readyFrame 缺省输出对齐的期望版本键（会话握手的对照面） */
const VALID_KEY = { protocol: "2", engineVersion: "v2", weightsFingerprint: "fp-current" };

const REQUEST_LINE = '{"type":"synthesize","id":1,"text":"你好"}\n';

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

/** 真实短命 dummy：pid 文件写它的号，kill 链路断言收到 SIGKILL；kill() 供未杀场景收尾防孤儿 */
async function makeLiveDummy(pidPath: string): Promise<{ pid: number; kill(): void; expectKilled(): Promise<string | null> }> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  child.unref();
  await sleep(50);
  if (child.exitCode !== null) throw new Error("dummy 子进程秒退，测试前提不成立");
  writeFileSync(pidPath, `${child.pid}\n`);
  const signal = new Promise<string | null>((resolve) => child.once("exit", (_code, sig) => resolve(sig)));
  return { pid: child.pid!, kill: () => child.kill("SIGKILL"), expectKilled: () => signal };
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

  it("ready 自述 pid 与 pid 文件不符：拒 kill 拒清文件直接 unavailable（pid 复用误杀防线）", async () => {
    const h = new Harness();
    try {
      const dummy = await makeLiveDummy(h.pidPath);
      try {
        h.track(await startFakeDaemon(h.sockPath, { ready: readyFrame({ protocol: "1", pid: dummy.pid + 1 }) }));
        await expect(h.session.ensure()).rejects.toBeInstanceOf(DaemonUnavailableError);
        expect(h.spawns).toHaveLength(0); // 归属不符即封顶，不空转重拉
        const outcome = await Promise.race([dummy.expectKilled(), sleep(300).then(() => "still-alive" as const)]);
        expect(outcome).toBe("still-alive"); // 无辜 pid 没被动过
        expect(existsSync(h.sockPath)).toBe(true); // 活 daemon 的注册点不碰
      } finally {
        dummy.kill();
      }
    } finally {
      await h.cleanup();
    }
  });

  it("ready 自述 pid 与 pid 文件一致：版本不符照 kill 照重拉（新 daemon 正常归属链路）", async () => {
    const h = new Harness();
    try {
      const dummy = await makeLiveDummy(h.pidPath);
      h.track(await startFakeDaemon(h.sockPath, { ready: readyFrame({ version: "v9", pid: dummy.pid }) }));
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

describe("DaemonSession 竞态仲裁：输家等待与加载宽限", () => {
  it("输家 exit 3 + 赢家加载中：转 connect 轮询等 ready（上限=加载窗），成功复用且不动赢家文件", async () => {
    const h = new Harness({ readyTimeoutMs: 1200 });
    try {
      const dummy = await makeLiveDummy(h.pidPath); // 赢家的 pid 文件在位（kill 归属核对的对照面）
      try {
        h.spawnHooks.push((proc) => {
          void sleep(30).then(async () => {
            const d = await startFakeDaemon(h.sockPath, { readyDelayMs: 150 }); // 加载中：可连但 ready 迟
            h.track(d);
          });
          setTimeout(() => proc.settle(3, null), 10); // 探针判负：他人已在位
        });
        await h.session.ensure();
        expect(h.spawns).toHaveLength(1);
        expect(existsSync(h.pidPath)).toBe(true); // 输家绝不 unlink 赢家的注册点
        const outcome = await Promise.race([dummy.expectKilled(), sleep(80).then(() => "still-alive" as const)]);
        expect(outcome).toBe("still-alive");
      } finally {
        dummy.kill();
      }
    } finally {
      await h.cleanup();
    }
  });

  it("输家 exit 3 但赢家始终不可连：等待上限到即判 unavailable，不重复拉起", async () => {
    const h = new Harness({ readyTimeoutMs: 300, pollIntervalMs: 20 });
    try {
      h.spawnHooks.push((proc) => setTimeout(() => proc.settle(3, null), 10));
      await expect(h.session.ensure()).rejects.toBeInstanceOf(DaemonUnavailableError);
      expect(h.spawns).toHaveLength(1);
      await expect(h.session.ensure()).rejects.toBeInstanceOf(DaemonUnavailableError);
      expect(h.spawns).toHaveLength(1); // sticky：本次调用不再触 daemon
    } finally {
      await h.cleanup();
    }
  });

  it("输家等待后连上过期赢家（ready 版本键不符）：仍按 pid 文件归属 kill 重拉", async () => {
    const h = new Harness({ readyTimeoutMs: 1200 });
    try {
      const dummy = await makeLiveDummy(h.pidPath);
      h.spawnHooks.push((proc) => {
        void startFakeDaemon(h.sockPath, { ready: readyFrame({ protocol: "1", pid: dummy.pid }) }).then((d) => h.track(d));
        setTimeout(() => proc.settle(3, null), 10);
      });
      h.spawnHooks.push(() => {
        void startFakeDaemon(h.sockPath).then((d) => h.track(d));
      });
      await h.session.ensure();
      expect(await dummy.expectKilled()).toBe("SIGKILL"); // 过期 daemon 的 kill 走 pid 文件而非输家自己的（已死的）拉起句柄
      expect(h.spawns).toHaveLength(2);
    } finally {
      await h.cleanup();
    }
  });

  it("warm 直连 ready 迟到但 pid 文件新鲜：判加载中续等至 ready 抵达，不 kill 不重拉", async () => {
    const h = new Harness({ warmTimeoutMs: 80, readyTimeoutMs: 1500 });
    try {
      const dummy = await makeLiveDummy(h.pidPath);
      try {
        h.track(await startFakeDaemon(h.sockPath, { readyDelayMs: 260 }));
        await h.session.ensure(); // 80ms warm 判负 → pid 年龄窗口内 → 续等到 260ms 的 ready
        expect(h.spawns).toHaveLength(0);
        expect(existsSync(h.sockPath)).toBe(true);
        const outcome = await Promise.race([dummy.expectKilled(), sleep(80).then(() => "still-alive" as const)]);
        expect(outcome).toBe("still-alive");
      } finally {
        dummy.kill();
      }
    } finally {
      await h.cleanup();
    }
  });

  it("spawn 句柄先连上再以非 3 码退场：进程已死归属即让渡，仍走 pid 文件 kill 重拉", async () => {
    const h = new Harness({ readyTimeoutMs: 1200 });
    try {
      const dummy = await makeLiveDummy(h.pidPath);
      h.spawnHooks.push((proc) => {
        void startFakeDaemon(h.sockPath, { ready: readyFrame({ protocol: "1", pid: dummy.pid }) }).then((d) => h.track(d));
        setTimeout(() => proc.settle(1, null), 10); // 先连上后死：退场码非 3 同样不构成归属权
      });
      h.spawnHooks.push(() => {
        void startFakeDaemon(h.sockPath).then((d) => h.track(d));
      });
      await h.session.ensure();
      expect(await dummy.expectKilled()).toBe("SIGKILL");
      expect(h.spawns).toHaveLength(2);
    } finally {
      await h.cleanup();
    }
  });

  it("pid 文件 mtime 在未来（时钟偏斜）：加载宽限拒信不可证起点，warm 超时即判 kill", async () => {
    const h = new Harness({ warmTimeoutMs: 80, readyTimeoutMs: 1500 });
    try {
      const dummy = await makeLiveDummy(h.pidPath);
      utimesSync(h.pidPath, new Date(), new Date(Date.now() + 60_000)); // 负年龄 = 「加载起点」不可信，宽限窗不予开启
      h.track(await startFakeDaemon(h.sockPath, { ready: "none" }));
      const t0 = Date.now();
      h.spawnHooks.push(() => {
        void startFakeDaemon(h.sockPath).then((d) => h.track(d));
      });
      await h.session.ensure();
      expect(Date.now() - t0).toBeLessThan(400); // 未被 1500ms 续等窗口拖长：负龄直接走僵死语义
      expect(await dummy.expectKilled()).toBe("SIGKILL");
      expect(h.spawns).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });

  it("spawn 句柄在位但注册点已被他人接管：完整让渡 external 归属核对，kill 在位者后照常重拉", async () => {
    const h = new Harness({ readyTimeoutMs: 600, pollIntervalMs: 20 });
    let dummy: Awaited<ReturnType<typeof makeLiveDummy>> | null = null;
    try {
      dummy = await makeLiveDummy(h.pidPath); // pid 文件指向 dummy 而非本会话 spawn 的 proc
      h.spawnHooks.push(() => {
        // proc 永不退场（socketFromSpawn 名义为 true）；对面 daemon ready 自述归属 dummy
        void startFakeDaemon(h.sockPath, { ready: readyFrame({ protocol: "1", pid: dummy!.pid }) }).then((d) => h.track(d));
      });
      await expect(h.session.ensure()).rejects.toBeInstanceOf(DaemonUnavailableError);
      // 接管检测让 owned 轮走 external：peerPid 与 pid 文件核对一致 → kill dummy + 清注册点
      // → 第二轮重拉。第二轮无供给 hook：fake proc 永不 bind → 加载窗尽判 unavailable 封顶。
      // dummy 之死即「未拿 spawn 句柄空杀自己、未弃权致轮次浪费」的可观测面
      expect(await dummy.expectKilled()).toBe("SIGKILL");
      expect(h.spawns).toHaveLength(2);
      expect(existsSync(h.sockPath)).toBe(false); // 在位过期 daemon 的注册点被正当清理
    } finally {
      dummy?.kill();
      await h.cleanup();
    }
  });

  it("warm 直连 ready 迟到且加载窗已耗尽：僵死终态照 kill 照重拉（S1 语义升级而非退化）", async () => {
    const h = new Harness({ warmTimeoutMs: 80, readyTimeoutMs: 350 });
    try {
      const dummy = await makeLiveDummy(h.pidPath);
      const t0 = Date.now();
      h.track(await startFakeDaemon(h.sockPath, { ready: "none" }));
      h.spawnHooks.push(() => {
        void startFakeDaemon(h.sockPath).then((d) => h.track(d));
      });
      await h.session.ensure();
      expect(Date.now() - t0).toBeGreaterThanOrEqual(300); // kill 不发生在 warm 5s 判据瞬间，而是加载窗耗尽后
      expect(await dummy.expectKilled()).toBe("SIGKILL");
      expect(h.spawns).toHaveLength(1);
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
