import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { startFakeDaemon } from "./daemon-fakes.ts";
import { DAEMON_QUEUE_FULL_MESSAGE } from "../src/engines/gptsovits-binding.ts";

/**
 * Python shim daemon 服务循环的真实现场测试：用系统 python3 直接跑 shim --daemon。
 * 仓库缺依赖的 lab 目录让加载必然 fatal——这恰好覆盖服务面最难测的骨架：
 * bind 先于加载、pid/log 落位、fatal 帧经 socket 送达、退出时残file清理、
 * EADDRINUSE 的活体判负（exit 3）与残file顶替。模型真加载归真机验收，这里测生命周期形态。
 * 另备「假引擎桩」形态（writeStubEngine）：lab 内落一份最小 GPT_SoVITS 包让 shim 真加载成功，
 * 覆盖只有活体 daemon 才能演的前后场——双进程 bind 竞态、队列容量拒转。
 */

const SHIM = fileURLToPath(new URL("../scripts/shims/gptsovits-shim.py", import.meta.url));

/**
 * 假引擎桩：lab/GPT-SoVITS 下最小 TTS/TTS_Config 替身（系统 python 有 numpy，桩产 int16 空样本）。
 * run 固定 sleep 0.4s 模拟单飞耗时——队列容量测试要靠它制造「一个在途、四个排队」的窗口。
 */
function writeStubEngine(lab: string): void {
  const root = join(lab, "GPT-SoVITS");
  const pkg = join(root, "GPT_SoVITS", "TTS_infer_pack");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(root, "GPT_SoVITS", "__init__.py"), "");
  writeFileSync(join(pkg, "__init__.py"), "");
  writeFileSync(
    join(pkg, "TTS.py"),
    [
      "import time",
      "",
      "class TTS_Config:",
      "    def __init__(self, cfg):",
      "        self.version = 'v2'",
      "        self.device = 'cpu'",
      "",
      "class TTS:",
      "    def __init__(self, config):",
      "        pass",
      "",
      "    def run(self, inputs):",
      "        time.sleep(0.4)",
      "        import numpy as np",
      "",
      "        yield 32000, np.zeros(8, dtype=np.int16)",
      "",
    ].join("\n"),
  );
}

/**
 * 连上 daemon 读到 ready 帧即收——假引擎加载毫秒级，但 python 解释器自身启动就有
 * sock 未落位的空窗：ENOENT/ECONNREFUSED 必须重试到就绪或超时，单次 connect 会撞空窗误报。
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

function onceReadyFrame(sockPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sockPath);
    let buf = "";
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error("stub engine ready 超时"));
    }, 2000);
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (buf.includes('"type": "ready"')) {
        clearTimeout(timer);
        conn.destroy();
        resolve();
      }
    });
    conn.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** 单请求一连接：写合成行，收首个 audio/error 终结帧 */
function driveOneRequest(sockPath: string, id: number, timeoutMs = 20_000): Promise<{ type: string; message?: string }> {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sockPath);
    let buf = "";
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error(`请求 ${id} 等待响应超时`));
    }, timeoutMs);
    conn.on("connect", () => {
      conn.write(`{"type":"synthesize","id":${id},"text":"竞态测试","ref_audio_path":"/r.wav","prompt_lang":"zh","text_lang":"zh","speed_factor":1.0}\n`);
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
          // exactOptionalPropertyTypes：message 缺席用展开表达，不写 undefined 键
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
  const lab = mkdtempSync(join(tmpdir(), "say-shim-"));
  mkdirSync(join(lab, "GPT-SoVITS"), { recursive: true }); // chdir 目标必须存在
  return run(lab).finally(() => rmSync(lab, { recursive: true, force: true }));
}

function startShim(lab: string, extraArgs: readonly string[] = []) {
  const proc = spawn("python3", [SHIM, "--daemon", "--repo", join(lab, "GPT-SoVITS"), "--lab", lab, ...extraArgs], { stdio: "ignore" });
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal })));
  return { proc, exit };
}

describe("shim --daemon 服务循环生命周期", () => {
  it("bind 先于加载：加载失败退出码 1，sock/pid 清净，daemon.log 留下 bind→fatal 全轨迹", async () => {
    await withTempLab(async (lab) => {
      const shim = startShim(lab);
      // 系统 python 缺依赖时 fatal 极快（bind 后秒级自退），不抢帧窗口：fatal 帧经 socket
      // 的送达面由 Node fake 矩阵钉死，这里断言事后可观测面（退出码 + 日志 + 残file清理）
      expect((await shim.exit).code).toBe(1);
      expect(existsSync(join(lab, "daemon.sock"))).toBe(false); // 残file挡下一个拉起者的路，退出必须清净
      expect(existsSync(join(lab, "daemon.pid"))).toBe(false);
      const log = readFileSync(join(lab, "daemon.log"), "utf8");
      expect(log).toContain("bind"); // 服务面自持日志：观测 idle/SIGTERM/fatal 的现场
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
        expect(winner.connects).toBeGreaterThanOrEqual(1); // 探针确实连过赢家
        expect(() => winner.close()).not.toThrow();
      }
    });
  }, 30_000);

  it("残file无人监听：判陈旧清掉重 bind，服务循环照常起（日志见加载失败而非 bind 异常）", async () => {
    await withTempLab(async (lab) => {
      const sockPath = join(lab, "daemon.sock");
      // 真僵死 sock：python 绑定后 SIGKILL，残留文件无人监听
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
      // 若顶替失败（bind 裸 OSError），日志只有 traceback 没有 bind/加载失败两行
      expect((await shim.exit).code).toBe(1);
      expect(existsSync(sockPath)).toBe(false);
      const log = readFileSync(join(lab, "daemon.log"), "utf8");
      expect(log).toContain("bind");
      expect(log).toContain("加载失败");
    });
  }, 30_000);
});

describe("shim --daemon 活体竞态与队列容量（假引擎桩）", () => {
  it("双 shim 并发 bind：后来者探针可连判负 exit 3，赢家 sock/pid 分毫未动", async () => {
    await withTempLab(async (lab) => {
      writeStubEngine(lab);
      const winner = startShim(lab);
      const sockPath = join(lab, "daemon.sock");
      try {
        await waitReadyFrame(sockPath);
        const pidBefore = readFileSync(join(lab, "daemon.pid"), "utf8");
        const loser = startShim(lab);
        expect((await loser.exit).code).toBe(3); // bind EADDRINUSE + 探针可连 = 他人在位，退出而不接管
        expect(readFileSync(join(lab, "daemon.pid"), "utf8")).toBe(pidBefore);
        expect(existsSync(sockPath)).toBe(true);
        loser.proc.kill("SIGKILL"); // 已退进程，兜底防孤儿
      } finally {
        winner.proc.kill("SIGTERM");
        expect((await winner.exit).code).toBe(0);
      }
    });
  }, 60_000);

  it("队列容量上限 4：六路请求恰一路收拒转 error 帧（message 与 TS 常量逐字一致），其余五路全出声", async () => {
    await withTempLab(async (lab) => {
      writeStubEngine(lab);
      const shim = startShim(lab);
      const sockPath = join(lab, "daemon.sock");
      try {
        await waitReadyFrame(sockPath);
        // 定序消除并发时序抖动：先让首路请求被单飞 worker 取走进入在途（假引擎每请求睡 0.4s），
        // 再灌后五路——此刻队列 4 位全被占用，第六路必拒，恰一拒而非受 get 竞态左右
        const first = driveOneRequest(sockPath, 0);
        await sleep(120);
        const rest = await Promise.all([1, 2, 3, 4, 5].map((i) => driveOneRequest(sockPath, i)));
        const results = [await first, ...rest];
        const rejects = results.filter((r) => r.type === "error" && (r.message ?? "").startsWith(DAEMON_QUEUE_FULL_MESSAGE));
        const audios = results.filter((r) => r.type === "audio");
        expect(rejects).toHaveLength(1); // 6 = 1 在途 + 4 排队 + 1 拒；恰一拒说明容量钉死在 4
        expect(audios).toHaveLength(5);
        expect(results.filter((r) => r.type === "error" && !(r.message ?? "").startsWith(DAEMON_QUEUE_FULL_MESSAGE))).toHaveLength(0);
      } finally {
        shim.proc.kill("SIGTERM");
        await shim.exit;
      }
    });
  }, 90_000);

  it("队满拒转 message 跨语言对拍：shim 源内常量与 TS 消费侧逐字一致（漂移即测试红，静默错判成引擎级失败不可接受）", () => {
    const py = readFileSync(SHIM, "utf8");
    const m = /QUEUE_FULL_MESSAGE = "([^"]+)"/.exec(py);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe(DAEMON_QUEUE_FULL_MESSAGE);
  });
});
