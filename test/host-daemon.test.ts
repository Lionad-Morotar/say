import { describe, expect, it } from "vitest";
import { createNodeHost } from "../src/host.ts";

/** 回声脚本：stdin 每行回写 stdout，EOF 后退出 0——常驻协议循环的最小真进程替身 */
const ECHO = "process.stdin.on('data', d => process.stdout.write(d)); process.stdin.on('end', () => process.exit(0));";

function collectLines(stream: NodeJS.ReadableStream): { lines: string[]; done: Promise<void> } {
  const lines: string[] = [];
  let buffer = "";
  const done = new Promise<void>((resolve) => {
    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let cut = buffer.indexOf("\n");
      while (cut >= 0) {
        lines.push(buffer.slice(0, cut));
        buffer = buffer.slice(cut + 1);
        cut = buffer.indexOf("\n");
      }
    });
    stream.on("end", resolve);
  });
  return { lines, done };
}

describe("createNodeHost.spawnDaemon", () => {
  it("stdin 写入经管道到达子进程，stdout 行可读，EOF 后 exit 0", async () => {
    const host = createNodeHost();
    const proc = host.spawnDaemon(process.execPath, ["-e", ECHO]);
    const out = collectLines(proc.stdout);
    proc.stdin.write("ping-1\n");
    proc.stdin.write("ping-2\n");
    proc.stdin.end();
    const exit = await proc.exit;
    await out.done;
    expect(exit).toEqual({ exitCode: 0, signal: null });
    expect(out.lines).toEqual(["ping-1", "ping-2"]);
  });

  it("spawn 本身失败（解释器不存在）折进 exit 的 SPAWN_ERROR，不另设错误通道", async () => {
    const host = createNodeHost();
    const proc = host.spawnDaemon("/nonexistent-say-probe/python3", ["-c", "pass"]);
    proc.stdin.end();
    const exit = await proc.exit;
    expect(exit.signal).toBe("SPAWN_ERROR");
    expect(exit.exitCode).toBeNull();
  });

  it("子进程中途被杀：exit 带 null code 与信号名，死亡后写 stdin 不炸宿主进程", async () => {
    const host = createNodeHost();
    // 挂住不退出的进程，给测试窗口去外部杀
    const proc = host.spawnDaemon(process.execPath, ["-e", "setInterval(() => {}, 1000);"]);
    expect(typeof proc.pid).toBe("number");
    await new Promise((resolve) => setTimeout(resolve, 150));
    process.kill(proc.pid!, "SIGKILL");
    const exit = await proc.exit;
    // 被信号杀死的进程 code 为 null，死因看 signal（node child_process 语义）
    expect(exit.exitCode).toBeNull();
    expect(exit.signal).toBe("SIGKILL");
    // 死亡后继续写 stdin：EPIPE 已被吞，宿主不崩（能走到断言即证明）
    proc.stdin.write("after-death\n");
    proc.stdin.end();
  });
});
