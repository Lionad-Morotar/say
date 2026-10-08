import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DAEMON_ENGINES } from "../src/config.ts";
import { formatRss, renderStatusTable, runDaemonCommand, runDaemonLs } from "../src/daemon-command.ts";
import { daemonPathsOf, type DaemonStatusRow } from "../src/daemon-status.ts";
import { expectedDaemonVersionKey } from "../src/engines/gptsovits-binding.ts";
import { createDefaultRegistry } from "../src/engines/index.ts";
import { EXIT_OK } from "../src/report.ts";
import { resolvePaths } from "../src/paths.ts";
import type { RunDeps } from "../src/deps.ts";
import { createFakeHost } from "./fake-host.ts";
import { readyFrame, startFakeDaemon } from "./daemon-fakes.ts";

/**
 * `say daemon ls` 输出面测试：表格是脚本可切列的数据面，列宽与占位符是接口的一部分；
 * 全表探测走并发（Promise.all），耗时上限 ≈ 单引擎探测而非四倍，用真 socket 集成用例守住。
 */

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function setup(psStdout: string | null = null) {
  const root = mkdtempSync(join(tmpdir(), "say-daemon-cmd-"));
  roots.push(root);
  const env = { XDG_DATA_HOME: root };
  const fake = createFakeHost({
    env,
    files: {},
    spawnOutcome: (record) =>
      record.cmd === "ps" && psStdout !== null
        ? { exitCode: 0, signal: null, stdout: psStdout, stderr: "" }
        : { exitCode: 1, signal: null, stdout: "", stderr: "" },
  });
  const deps: RunDeps = {
    host: fake.host,
    paths: resolvePaths(env),
    registry: createDefaultRegistry(fake.host),
    sayBin: "/usr/bin/say",
  };
  return { fake, deps, root };
}

function stdoutOf(fake: ReturnType<typeof createFakeHost>): string {
  return fake.stdout.join("");
}

describe("formatRss：常驻体量的读数口径", () => {
  it.each([
    [null, "-"],
    [999, "999KB"],
    [1024, "1.0MB"],
    [1536, "1.5MB"],
    [1048576, "1.0GB"],
    [5242880, "5.0GB"],
  ] as const)("%j → %j", (kb, text) => {
    expect(formatRss(kb)).toBe(text);
  });
});

describe("renderStatusTable：列宽钉死可脚本切列", () => {
  it("表头与行按固定列序渲染，无值列用 - 占位", () => {
    const rows: DaemonStatusRow[] = [
      { engine: "gptsovits", state: "warm", pid: 4242, rssKb: 5242880, etime: "03:12:45", note: "v=v2 device=cpu" },
      { engine: "indextts", state: "idle", pid: null, rssKb: null, etime: null, note: "无常驻，下次 say 调用 lazy 拉起" },
    ];
    const table = renderStatusTable(rows);
    const [header, warmLine, idleLine] = table.split("\n");
    expect(header).toBe("ENGINE  STATE  PID  UP  RSS  NOTE");
    expect(warmLine).toContain("gptsovits");
    expect(warmLine).toContain("warm");
    expect(warmLine).toContain("   4242"); // pid 右对齐 7 列
    expect(warmLine).toContain("5.0GB"); // rss 右对齐 8 列
    expect(idleLine).toContain("idle");
    expect(idleLine).toMatch(/-\s+-\s+-/); // pid/up/rss 三连占位
  });
});

describe("runDaemonLs：全表探测", () => {
  it("零注册点：四引擎全 idle，不 spawn ps，exit 0", async () => {
    const { fake, deps } = setup();
    const code = await runDaemonLs(deps);
    expect(code).toBe(EXIT_OK);
    const out = stdoutOf(fake);
    expect(out.trimEnd().split("\n")).toHaveLength(DAEMON_ENGINES.length + 1); // 表头 + 四行
    for (const engine of DAEMON_ENGINES) {
      expect(out).toContain(engine);
      expect(out).toContain("idle");
    }
    expect(fake.spawns).toEqual([]);
  });

  it("daemon 子命令分派到 ls 渲染路径", async () => {
    const { fake, deps } = setup();
    const code = await runDaemonCommand(deps, { kind: "daemon", action: "ls" });
    expect(code).toBe(EXIT_OK);
    expect(stdoutOf(fake)).toContain("ENGINE  STATE");
  });

  it("并发全表：一引擎真 warm 三引擎 idle，warm 行带 pid/rss，耗时不随引擎数线性堆叠", async () => {
    const { fake, deps, root } = setup(`  2097152  00:45:12\n`);
    const paths = daemonPathsOf({ XDG_DATA_HOME: root }, "gptsovits");
    mkdirSync(paths.labDir, { recursive: true });
    const expected = expectedDaemonVersionKey(paths.labDir);
    const daemon = await startFakeDaemon(paths.sockPath, {
      ready: readyFrame({ version: expected.engineVersion, weights_fingerprint: expected.weightsFingerprint }),
    });
    try {
      fake.files.set(paths.sockPath, "");
      fake.files.set(paths.pidPath, `${process.pid}\n`);
      const t0 = Date.now();
      const code = await runDaemonLs(deps);
      const elapsed = Date.now() - t0;
      expect(code).toBe(EXIT_OK);
      const out = stdoutOf(fake);
      const lines = out.trim().split("\n");
      expect(lines).toHaveLength(5);
      expect(lines[1]).toContain("gptsovits");
      expect(lines[1]).toContain("warm");
      expect(lines[1]).toContain("2.0GB");
      expect(lines[1]).toContain(String(process.pid));
      for (const line of lines.slice(2)) expect(line).toContain("idle");
      // 并发承诺：单引擎探测预算 2s，若串行堆叠 warm 用例本不该超 4s；真 socket 即答时留足 CI 余量
      expect(elapsed).toBeLessThan(4_000);
    } finally {
      await daemon.close();
    }
  });
});
