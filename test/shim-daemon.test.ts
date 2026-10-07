import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { startFakeDaemon } from "./daemon-fakes.ts";

/**
 * Python shim daemon 服务循环的真实现场测试：用系统 python3 直接跑 shim --daemon。
 * 仓库缺依赖的 lab 目录让加载必然 fatal——这恰好覆盖服务面最难测的骨架：
 * bind 先于加载、pid/log 落位、fatal 帧经 socket 送达、退出时残file清理、
 * EADDRINUSE 的活体判负（exit 3）与残file顶替。模型真加载归真机验收，这里测生命周期形态。
 */

const SHIM = fileURLToPath(new URL("../scripts/shims/gptsovits-shim.py", import.meta.url));

function withTempLab(run: (lab: string) => Promise<void>): Promise<void> {
  const lab = mkdtempSync(join(tmpdir(), "say-shim-"));
  mkdirSync(join(lab, "GPT-SoVITS"), { recursive: true }); // chdir 目标必须存在
  return run(lab).finally(() => rmSync(lab, { recursive: true, force: true }));
}

function startShim(lab: string, extraArgs: readonly string[] = []) {
  const proc = spawn("python3", [SHIM, "--daemon", "--repo", join(lab, "GPT-SoVITS"), "--lab", lab, ...extraArgs], { stdio: "ignore" });
  const exit = new Promise<number | null>((resolve) => proc.once("exit", (code) => resolve(code)));
  return { proc, exit };
}

describe("shim --daemon 服务循环生命周期", () => {
  it("bind 先于加载：加载失败退出码 1，sock/pid 清净，daemon.log 留下 bind→fatal 全轨迹", async () => {
    await withTempLab(async (lab) => {
      const shim = startShim(lab);
      // 系统 python 缺依赖时 fatal 极快（bind 后秒级自退），不抢帧窗口：fatal 帧经 socket
      // 的送达面由 Node fake 矩阵钉死，这里断言事后可观测面（退出码 + 日志 + 残file清理）
      expect(await shim.exit).toBe(1);
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
        expect(await shim.exit).toBe(3);
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
      expect(await shim.exit).toBe(1);
      expect(existsSync(sockPath)).toBe(false);
      const log = readFileSync(join(lab, "daemon.log"), "utf8");
      expect(log).toContain("bind");
      expect(log).toContain("加载失败");
    });
  }, 30_000);
});
