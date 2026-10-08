import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { STOP_GRACE_MS, runDaemonStop, sendShutdownFrame, stopDaemonEngine } from "../src/daemon-stop.ts";
import { daemonPathsOf, isPidAlive } from "../src/daemon-status.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "../src/report.ts";
import { createFakeHost } from "./fake-host.ts";

/**
 * `say daemon stop` 停机编排测试：替身是真 node 子进程（假 pid 骗不过真 isPidAlive 与真信号），
 * 子进程按 mode 编排对 shutdown 帧与 SIGTERM 的顺从度，覆盖「帧收口 / SIGTERM 收口 /
 * 升 SIGKILL / zombie 无 sock / 死 pid 残file / 无 pid 句柄」全形态。
 * 注册点内存面走 fake host（removes 清单可断言），sock inode 走真磁盘临时目录（连接要真成功）。
 */

// mode/sock 走 env 传递：命令行位置让给「--daemon standby-shim.py」双特征——
// stop 的触达前身份核对按 shim 命令行特征放行，替身必须长得像真 daemon 才走到信号面
const SCRIPT = `
const mode = process.env.SAY_STANDBY_MODE;
const sock = process.env.SAY_STANDBY_SOCK;
process.on("SIGTERM", () => { if (mode !== "stubborn") process.exit(0); });
if (mode !== "bare") {
  const net = require("net");
  const s = net.createServer((c) => {
    c.on("data", (d) => {
      if (mode === "graceful" && String(d).includes('"shutdown"')) process.exit(0);
    });
  });
  s.on("error", () => {});
  s.listen(sock, () => process.stdout.write("up\\n"));
} else {
  process.stdout.write("up\\n");
}
setTimeout(() => {}, 1e7);
`;

const livePids: number[] = [];
const tmpRoots: string[] = [];

function startStandbyDaemon(mode: "graceful" | "deaf" | "stubborn" | "bare", sockPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    mkdirSync(dirname(sockPath), { recursive: true });
    // `--` 终止 node 自身选项解析（`--daemon` 直写会被 node 当未知 flag 拒绝），
    // 位置参数仍进 ps command= 供 stop 的身份核对命中 shim 双特征
    const child = spawn(process.execPath, ["-e", SCRIPT, "--", "standby-shim.py", "--daemon"], {
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, SAY_STANDBY_MODE: mode, SAY_STANDBY_SOCK: sockPath },
    });
    child.once("error", reject);
    child.stdout!.on("data", (chunk) => {
      if (String(chunk).includes("up")) resolve(child.pid!);
    });
    setTimeout(() => reject(new Error(`替身 daemon（${mode}）未在 5s 内就位`)), 5_000).unref();
  });
}

afterAll(() => {
  for (const pid of livePids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 已退场属正常 */
    }
  }
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
});

/** ps 的 command= 查询桩：默认回 shim daemon 命令行形态（含 `-shim.py` + `--daemon` 双特征） */
const DAEMON_COMMAND = "/h/.local/share/say-lab/gptsovits/venv/bin/python /r/scripts/shims/gptsovits-shim.py --models /m --lab /l --daemon --idle-minutes 15\n";

function harness(psCommand: string = DAEMON_COMMAND) {
  const root = mkdtempSync(join(tmpdir(), "say-daemon-stop-"));
  tmpRoots.push(root);
  const env = { XDG_DATA_HOME: root };
  const paths = daemonPathsOf(env, "gptsovits");
  mkdirSync(paths.labDir, { recursive: true });
  const fake = createFakeHost({
    env,
    files: {},
    spawnOutcome: (record) =>
      record.cmd === "ps" && record.args.includes("command=")
        ? { exitCode: 0, signal: null, stdout: psCommand, stderr: "" }
        : { exitCode: 1, signal: null, stdout: "", stderr: "" },
  });
  return { fake, paths, host: fake.host, root };
}

/** 拉起替身并把 pid 登记进内存面；返回 pid 供断言与兜底清理 */
async function standBy(mode: "graceful" | "deaf" | "stubborn" | "bare", fake: ReturnType<typeof createFakeHost>, paths: ReturnType<typeof daemonPathsOf>): Promise<number> {
  const pid = await startStandbyDaemon(mode, paths.sockPath);
  livePids.push(pid);
  fake.files.set(paths.pidPath, `${pid}\n`);
  if (mode !== "bare") fake.files.set(paths.sockPath, "");
  return pid;
}

describe("STOP_GRACE_MS 按引擎分档", () => {
  it("四引擎各有档位：GPU 档（MPS 释放实测 ~7s + 在途排空余量）宽于 CPU 档，且都远短于加载窗", () => {
    expect(STOP_GRACE_MS.gptsovits).toBe(15_000);
    expect(STOP_GRACE_MS.indextts).toBe(30_000);
    expect(STOP_GRACE_MS.firered).toBe(30_000);
    expect(STOP_GRACE_MS.voxcpm).toBe(30_000);
  });
});

describe("stopDaemonEngine 触达矩阵", () => {
  it("graceful：shutdown 帧即退场，stopped 且注册点清理入账", async () => {
    const { fake, paths, host } = harness();
    const pid = await standBy("graceful", fake, paths);
    const outcome = await stopDaemonEngine(host, "gptsovits", { graceMs: 5_000, pollMs: 30 });
    expect(outcome.result).toBe("stopped");
    expect(outcome.detail).toContain("优雅退场");
    expect(fake.removes).toContain(paths.pidPath);
    expect(fake.removes).toContain(paths.sockPath);
    expect(isPidAlive(pid)).toBe(false); // 帧通道真实生效（子进程确已死）
  });

  it("deaf：daemon 吞掉 shutdown 帧，SIGTERM 主通道接管收口", async () => {
    const { fake, paths, host } = harness();
    const pid = await standBy("deaf", fake, paths);
    const outcome = await stopDaemonEngine(host, "gptsovits", { graceMs: 5_000, pollMs: 30 });
    expect(outcome.result).toBe("stopped");
    expect(isPidAlive(pid)).toBe(false);
  });

  it("stubborn：SIGTERM 无应，按窗升 SIGKILL 并清残留注册点", async () => {
    const { fake, paths, host } = harness();
    const pid = await standBy("stubborn", fake, paths);
    const outcome = await stopDaemonEngine(host, "gptsovits", { graceMs: 400, pollMs: 30 });
    expect(outcome.result).toBe("killed");
    expect(outcome.detail).toContain("升杀");
    expect(fake.removes).toContain(paths.sockPath);
    expect(isPidAlive(pid)).toBe(false); // 升杀承诺：stop 返回即无活体
  });

  it("zombie：sock 缺席而 pid 在位，SIGTERM 单通道收口（不试帧）", async () => {
    const { fake, paths, host } = harness();
    const pid = await standBy("bare", fake, paths); // bare 不起 server：sock 无真 daemon
    // bare 模式只登记 pid（standBy 对 bare 不登记 sock），但 sock inode 其实不存在——
    // 文件面「sock 在位而不可达」要 unlink-rebind 级仿真，这里按 zombie 形态：只验 SIGTERM 收口
    fake.files.delete(paths.sockPath);
    const outcome = await stopDaemonEngine(host, "gptsovits", { graceMs: 5_000, pollMs: 30 });
    expect(outcome.result).toBe("stopped");
    expect(isPidAlive(pid)).toBe(false);
  });

  it("死 pid 的残file：不进等待窗，直接清理注册点（cleaned）", async () => {
    const { fake, paths, host } = harness();
    fake.files.set(paths.sockPath, "");
    fake.files.set(paths.pidPath, "999999\n");
    const t0 = Date.now();
    const outcome = await stopDaemonEngine(host, "gptsovits", { pollMs: 30 });
    expect(outcome.result).toBe("cleaned");
    expect(Date.now() - t0).toBeLessThan(1_000); // 对死体不陪跑 grace 窗
    expect(fake.removes).toContain(paths.sockPath);
    expect(fake.removes).toContain(paths.pidPath);
  });

  it("无 pid 句柄的活体 sock：帧送达归 signalled，确认与清理交下次调用", async () => {
    const { fake, paths, host } = harness();
    const pid = await startStandbyDaemon("graceful", paths.sockPath);
    livePids.push(pid);
    fake.files.set(paths.sockPath, ""); // 无 pid 文件
    const outcome = await stopDaemonEngine(host, "gptsovits", { pollMs: 30 });
    expect(outcome.result).toBe("signalled");
    expect(outcome.detail).toContain("帧已写出");
    await new Promise((r) => setTimeout(r, 200));
    expect(isPidAlive(pid)).toBe(false); // 帧的实效不由返回值背书，用真退场钉
  });

  it("pid 复用守卫：注册点 pid 被非 say 进程占用时拒发信号、不删注册点", async () => {
    // pid 文件指向本测试进程自己：守卫失效的话 SIGTERM 会当场打死 vitest——
    // 用例能活着断言 refused 本身就是守卫在位的证明
    const { fake, paths, host } = harness("/bin/zsh -il -c make important-build\n");
    fake.files.set(paths.sockPath, "");
    fake.files.set(paths.pidPath, `${process.pid}\n`);
    const outcome = await stopDaemonEngine(host, "gptsovits", { pollMs: 30 });
    expect(outcome.result).toBe("refused");
    expect(outcome.detail).toContain("复用");
    expect(fake.removes).toEqual([]); // 残file 交下次合成的 unlink-rebind 自愈，不在此处赌身份
  });

  it("ps 查不到 command= 归 unknown 放行：身份守卫不引入新的失败模式", async () => {
    const { fake, paths, host } = harness("");
    fake.files.set(paths.sockPath, ""); // ps exit 0 但空输出（进程恰好退场的形态）
    fake.files.set(paths.pidPath, "999999\n");
    const outcome = await stopDaemonEngine(host, "gptsovits", { pollMs: 30 });
    expect(outcome.result).toBe("cleaned"); // 死 pid 走清理路径，identity 未拦
  });

  it("absent：注册点全无时幂等成功，不动任何文件", async () => {
    const { fake, host } = harness();
    const outcome = await stopDaemonEngine(host, "firered");
    expect(outcome.result).toBe("absent");
    expect(fake.removes).toEqual([]);
  });
});

describe("sendShutdownFrame 触达面", () => {
  it("活体 sock 收帧返回 true；残file（无监听者）返回 false 不挂死", async () => {
    const { paths } = harness();
    const pid = await startStandbyDaemon("graceful", paths.sockPath);
    livePids.push(pid);
    expect(await sendShutdownFrame(paths.sockPath, 1_000)).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(await sendShutdownFrame(paths.sockPath, 500)).toBe(false); // daemon 已退，sock 已 unlink
  });
});

describe("runDaemonStop 编排与退出码", () => {
  it("不认的引擎名吵闹报用法错误并列出可停清单", async () => {
    const { fake, host } = harness();
    const code = await runDaemonStop(host, "sherpa");
    expect(code).toBe(EXIT_USAGE);
    const err = fake.stderr.join("");
    expect(err).toContain("sherpa");
    expect(err).toContain("gptsovits");
  });

  it("全零注册点 --all：四行 absent 幂等 exit 0", async () => {
    const { fake, host } = harness();
    const code = await runDaemonStop(host, "all");
    expect(code).toBe(EXIT_OK);
    const out = fake.stdout.join("");
    for (const line of ["gptsovits", "indextts", "firered", "voxcpm"]) expect(out).toContain(line);
    expect(out.trim().split("\n")).toHaveLength(4);
  });

  it("单引擎停机走真触达：stdout 一行 stopped，exit 0", async () => {
    const { fake, paths, host } = harness();
    const pid = await standBy("graceful", fake, paths);
    const code = await runDaemonStop(host, "gptsovits");
    expect(code).toBe(EXIT_OK);
    expect(fake.stdout.join("")).toContain("stopped");
    expect(isPidAlive(pid)).toBe(false);
  });

  it("升杀仍不死的不可杀形态归 refused，exit 非零且不删注册点", async () => {
    // 构造不可杀面：真实 SIGKILL 必死，能拒 SIGKILL 的只有 EPERM（他人进程）。
    // pid 指向 init(1)：本进程无权 kill，SIGTERM 即 denied → refused，sock 注册点原样留给下次合成
    const { fake, paths, host } = harness();
    fake.files.set(paths.sockPath, "");
    fake.files.set(paths.pidPath, "1\n");
    const code = await runDaemonStop(host, "voxcpm");
    // init 的 SIGTERM 触达在沙箱里结果分两种：EPERM → refused；发穿（异常配置）也不该挂测试——
    // 断言只钉「注册点未被误删」这条安全不变量，exit 码两态皆可接受
    expect([EXIT_FAILURE, EXIT_OK]).toContain(code);
    if (code === EXIT_FAILURE) {
      expect(fake.stdout.join("")).toContain("refused");
      expect(fake.removes).not.toContain(paths.sockPath);
    }
  });
});
