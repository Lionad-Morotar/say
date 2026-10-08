import net from "node:net";
import { DAEMON_ENGINES, type DaemonEngine } from "./config.ts";
import type { Host } from "./host.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "./report.ts";
import { daemonPathsOf, isPidAlive, readDaemonPid } from "./daemon-status.ts";

/**
 * `say daemon stop` 的停机编排（形态按蓝图：SIGTERM 优雅停 + 超时 SIGKILL + 清 sock 残留）。
 * 双通道并发触达是形态必然：shutdown 帧走 sock（覆盖 pid 文件丢失的常驻体），
 * SIGTERM 走 pid（覆盖 sock 脱落的 zombie）；shim 两路都收敛到 stop_flag，重复触达幂等。
 * 与 ls 的只读纪律相反，stop 是写侧命令：unlink 只在确认进程死亡后发生——
 * 活着的 daemon 先删注册点会让并发合成调用误判 lazy 拉起撞 EADDRINUSE。
 */

/**
 * 按引擎的优雅退场窗，超时升 SIGKILL。数值来源（真机实测，非拍脑袋）：
 * indextts SIGTERM 退场 ~7s（torch/MPS 资源释放延迟，真机台账沉淀），firered/voxcpm 同栈未单独
 * 实测、取同量级；gptsovits CPU 档毫秒级退场，窗给 15s 覆盖「在途一句排空 + 释放」的坏例。
 * 一刀切的否决理由：CPU 档等 GPU 档的窗是白等，GPU 档吃 CPU 档的窗会误杀在途合成。
 */
export const STOP_GRACE_MS: Readonly<Record<DaemonEngine, number>> = {
  gptsovits: 15_000,
  indextts: 30_000,
  firered: 30_000,
  voxcpm: 30_000,
};

/** SIGKILL 后的收尸确认窗：kill -9 到进程表回收是内核动作，毫秒级；5s 是纯保险 */
const KILL_CONFIRM_MS = 5_000;

export type StopResult = "absent" | "stopped" | "killed" | "cleaned" | "signalled" | "refused";

export interface StopOutcome {
  engine: DaemonEngine;
  result: StopResult;
  /** 从开始触达到确认死亡的墙钟耗时；absent/signalled 为 0 */
  waitedMs: number;
  /** 人读一行归因（stdout 表格的尾列） */
  detail: string;
}

/** 写侧文件清理走 Host.removeFile：真 adapter 是 fs.unlink，内存 fake 记 removes 清单 */
async function cleanupRegistrationPoints(host: Host, sockPath: string, pidPath: string): Promise<void> {
  if (host.fileExists(pidPath)) await host.removeFile(pidPath);
  if (host.fileExists(sockPath)) await host.removeFile(sockPath);
}

function sendSignal(pid: number, signal: NodeJS.Signals): "sent" | "gone" | "denied" {
  try {
    process.kill(pid, signal);
    return "sent";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone"; // 恰好退场：与发成功等价
    if (code === "EPERM") return "denied"; // 他人进程：无权收尸也不该动其注册点
    return "gone"; // EINVAL 之类的信号名问题不该出现，保守当无进程可触达
  }
}

/** shutdown 帧触达：写成功（flush 回调）即 true；拒连/残file/超时 false，由 pid 通道继续兜 */
export function sendShutdownFrame(sockPath: string, budgetMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = net.connect(sockPath);
    const timer = setTimeout(() => {
      conn.destroy();
      resolve(false);
    }, budgetMs);
    timer.unref();
    conn.once("error", () => {
      clearTimeout(timer);
      conn.destroy();
      resolve(false);
    });
    conn.on("connect", () => {
      conn.end(`${JSON.stringify({ type: "shutdown" })}\n`, () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  });
}

/**
 * 触达前的 pid 身份核对：SIGKILL/崩溃残留的注册点里 pid 可能被内核复用给同用户进程，
 * isPidAlive 只证明存在不证明归属——对复用体发 SIGTERM 是误杀用户活跃进程。
 * shim daemon 命令行有「*-shim.py + --daemon」双特征（spawnDaemon 的装配面），非符判复用；
 * ps 不可用/查不到归 unknown 放行：守卫不引入新的失败模式，退场确认仍由 isPidAlive 收敛。
 */
async function classifyPidIdentity(host: Host, pid: number): Promise<"daemon" | "reused" | "unknown"> {
  try {
    const outcome = await host.spawn("ps", ["-o", "command=", "-p", String(pid)]);
    if (outcome.exitCode !== 0) return "unknown";
    const command = outcome.stdout.trim();
    if (command.length === 0) return "unknown"; // 恰在此刻退场：交给存活探测的自然收敛
    return /-shim\.py\b/.test(command) && /--daemon\b/.test(command) ? "daemon" : "reused";
  } catch {
    return "unknown";
  }
}

async function waitForExit(pid: number, budgetMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (!isPidAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export interface StopTuning {
  /** 测试收窗：真机走 STOP_GRACE_MS 缺省 */
  graceMs?: number;
  pollMs?: number;
}

/**
 * 单引擎停机。时序：探注册点 → sock 在则发 shutdown 帧 → pid 在则补 SIGTERM →
 * 按引擎窗等退场 → 不退场升 SIGKILL + 5s 确认 → 确认死亡后清残留注册点。
 * 「pid 在位但已死」的残file 形态直接走清理（cleaned），不进等待窗——对死体陪跑是白等。
 */
export async function stopDaemonEngine(host: Host, engine: DaemonEngine, tuning: StopTuning = {}): Promise<StopOutcome> {
  const { sockPath, pidPath } = daemonPathsOf(host.env, engine);
  const graceMs = tuning.graceMs ?? STOP_GRACE_MS[engine];
  const pollMs = tuning.pollMs ?? 100;
  const sockExists = host.fileExists(sockPath);
  const pid = await readDaemonPid(host, pidPath);

  if (!sockExists && pid === null) {
    return { engine, result: "absent", waitedMs: 0, detail: "无常驻，无事可做" };
  }

  const t0 = Date.now();
  const frameSent = sockExists ? await sendShutdownFrame(sockPath) : false;
  const waited = (): number => Date.now() - t0;

  if (pid === null) {
    // pid 文件缺失但 sock 在位：帧已写出（或注册点是残file 没人收），无 pid 柄可确认与清理
    return {
      engine,
      result: "signalled",
      waitedMs: waited(),
      detail: frameSent ? "shutdown 帧已写出（flush 完成不等于 daemon 处理，实效交下次调用确认）" : "sock 在位但不可达且无 pid 句柄，未触达",
    };
  }

  if (!isPidAlive(pid)) {
    await cleanupRegistrationPoints(host, sockPath, pidPath);
    return { engine, result: "cleaned", waitedMs: waited(), detail: "pid 已死，清掉残留注册点" };
  }

  if ((await classifyPidIdentity(host, pid)) === "reused") {
    return { engine, result: "refused", waitedMs: waited(), detail: "pid 疑被非 say 进程复用：拒动信号（爆炸半径是误杀活跃进程），注册点残file 交下次合成的 unlink-rebind 自愈" };
  }

  const term = sendSignal(pid, "SIGTERM");
  if (term === "gone") {
    await cleanupRegistrationPoints(host, sockPath, pidPath);
    return { engine, result: "cleaned", waitedMs: waited(), detail: "SIGTERM 竞态：发信号时进程已退场，顺带清注册点" };
  }
  if (term === "denied") {
    return { engine, result: "refused", waitedMs: waited(), detail: "pid 属他人进程（EPERM）：无权收尸，注册点也留给下次合成的 unlink-rebind" };
  }

  if (await waitForExit(pid, graceMs, pollMs)) {
    await cleanupRegistrationPoints(host, sockPath, pidPath);
    return { engine, result: "stopped", waitedMs: waited(), detail: `优雅退场（shutdown 帧 + SIGTERM，窗 ${Math.round(graceMs / 1000)}s）` };
  }

  const kill = sendSignal(pid, "SIGKILL");
  if (kill === "denied") {
    return { engine, result: "refused", waitedMs: waited(), detail: `窗 ${graceMs / 1000}s 内无退场迹象且 SIGKILL 被拒（EPERM）` };
  }
  if (await waitForExit(pid, KILL_CONFIRM_MS, pollMs)) {
    await cleanupRegistrationPoints(host, sockPath, pidPath);
    return { engine, result: "killed", waitedMs: waited(), detail: `SIGTERM 窗 ${graceMs / 1000}s 无退场，SIGKILL 升杀并清残留注册点` };
  }
  return { engine, result: "refused", waitedMs: waited(), detail: "SIGKILL 后进程仍在位（不可杀形态，如内核僵尸/不可中断 IO），不删注册点" };
}

/** 结果行的成败分类：refused 是 stop 唯一失败语义，其余（含 absent 幂等）都算成事 */
export function stopFailed(outcome: StopOutcome): boolean {
  return outcome.result === "refused";
}

function formatStopLine(outcome: StopOutcome): string {
  return `${outcome.engine.padEnd(10)} ${outcome.result.padEnd(9)} ${outcome.detail}`;
}

/**
 * `say daemon stop <engine|--all>` 编排：目标校验在编排层（解析层忠实映射 argv 的纪律）；
 * 逐引擎串行停机——并发 SIGTERM 与清理有撞车面，且 stop 不承诺秒级耗时，串行归因更可读。
 */
export async function runDaemonStop(host: Host, target: string): Promise<number> {
  const targets: DaemonEngine[] = target === "all" ? [...DAEMON_ENGINES] : DAEMON_ENGINES.includes(target as DaemonEngine) ? [target as DaemonEngine] : [];
  if (targets.length === 0) {
    host.writeStderr(`say: daemon stop 不认引擎 "${target}"（可停：${DAEMON_ENGINES.join(" / ")} 或 --all）\n`);
    return EXIT_USAGE;
  }
  const outcomes: StopOutcome[] = [];
  for (const engine of targets) {
    const outcome = await stopDaemonEngine(host, engine);
    outcomes.push(outcome);
    host.writeStdout(`${formatStopLine(outcome)}\n`);
  }
  return outcomes.some(stopFailed) ? EXIT_FAILURE : EXIT_OK;
}
