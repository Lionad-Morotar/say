import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  daemonPathsOf,
  etimeToSeconds,
  probeDaemonSock,
  probeDaemonStatus,
  readDaemonPid,
} from "../src/daemon-status.ts";
import { expectedDaemonVersionKey } from "../src/engines/gptsovits-binding.ts";
import { createFakeHost } from "./fake-host.ts";
import { readyFrame, startFakeDaemon } from "./daemon-fakes.ts";

/**
 * `say daemon ls` 观测面测试（热启动）：六态判定矩阵走真 unix socket——
 * warm/stale/loading/fatal 的差别全在 ready 帧的到达与否与内容相符与否，
 * 传输时序（bind 后不出 ready）只有真服务端能给。pid 生死走真 process.kill(pid,0)
 * （活体用 process.pid，死体用 999999），rss/etime 走 ps 桩——观测面自己 spawn 的
 * 真 ps 会随机器负载抖动，形态断言不收这个噪声。
 */

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** 每用例一个隔离 data 根：labDir 落真目录供 socket bind，files 表是内存面（pid 文件） */
function harness(psStdout: string | null = null) {
  const root = mkdtempSync(join(tmpdir(), "say-daemon-ls-"));
  roots.push(root);
  const env = { XDG_DATA_HOME: root };
  const paths = daemonPathsOf(env, "gptsovits");
  mkdirSync(paths.labDir, { recursive: true });
  const fake = createFakeHost({
    env,
    files: {},
    spawnOutcome: (record) =>
      record.cmd === "ps" && psStdout !== null
        ? { exitCode: 0, signal: null, stdout: psStdout, stderr: "" }
        : { exitCode: 1, signal: null, stdout: "", stderr: "" },
  });
  return { fake, paths, host: fake.host };
}

describe("daemonPathsOf 与 session 的注册点落位同源", () => {
  it("sock/pid 两件都落在 say-lab/<engine> 之下", () => {
    const p = daemonPathsOf({ XDG_DATA_HOME: "/d" }, "indextts");
    expect(p.labDir).toBe("/d/say-lab/indextts");
    expect(p.sockPath).toBe("/d/say-lab/indextts/daemon.sock");
    expect(p.pidPath).toBe("/d/say-lab/indextts/daemon.pid");
  });
});

describe("etimeToSeconds：BSD ps etime 的龄期折算", () => {
  it.each([
    ["03:04", 184],
    ["1:02:03", 3723],
    ["2-03:04:05", 2 * 86400 + 3 * 3600 + 4 * 60 + 5],
    ["59:59", 3599],
  ])("%j → %j 秒", (etime, sec) => {
    expect(etimeToSeconds(etime)).toBe(sec);
  });

  it("不合形的原文归 null 而非猜测：宁可少判一档 loading 不误判龄期", () => {
    expect(etimeToSeconds("184")).toBeNull();
    expect(etimeToSeconds("")).toBeNull();
    expect(etimeToSeconds("ab:cd")).toBeNull();
  });
});

describe("readDaemonPid：pid 文件容错", () => {
  it("缺文件/坏内容归 null，正常行去空白取整数", async () => {
    const { host, paths } = harness();
    expect(await readDaemonPid(host, paths.pidPath)).toBeNull();
    const withJunk = createFakeHost({ files: { [paths.pidPath]: "not-a-pid" } }).host;
    expect(await readDaemonPid(withJunk, paths.pidPath)).toBeNull();
    const withPid = createFakeHost({ files: { [paths.pidPath]: `${process.pid}\n` } }).host;
    expect(await readDaemonPid(withPid, paths.pidPath)).toBe(process.pid);
  });
});

describe("probeDaemonStatus 六态矩阵", () => {
  it("idle：注册点三件全无，无常驻且指明 lazy 拉起", async () => {
    const { fake, host } = harness();
    const row = await probeDaemonStatus(host, "gptsovits");
    expect(row.state).toBe("idle");
    expect(row.pid).toBeNull();
    expect(row.rssKb).toBeNull();
    expect(row.note).toContain("lazy");
    expect(fake.spawns).toEqual([]); // 无进程可问津就不该 spawn ps
  });

  it("zombie：pid 在位而 sock 缺席，判常驻体注册点脱落", async () => {
    const { fake, host, paths } = harness(`  1024  01:00\n`);
    fake.files.set(paths.pidPath, `${process.pid}\n`);
    const row = await probeDaemonStatus(host, "gptsovits");
    expect(row.state).toBe("zombie");
    expect(row.pid).toBe(process.pid);
    expect(row.note).toContain("sock 缺席");
  });

  it("warm：握手三元组与 binding 权威投影逐位相符，rss/etime 进表", async () => {
    const { fake, host, paths } = harness(`  5242880  03:12:45\n`);
    const expected = expectedDaemonVersionKey(paths.labDir);
    const daemon = await startFakeDaemon(paths.sockPath, {
      ready: readyFrame({ version: expected.engineVersion, weights_fingerprint: expected.weightsFingerprint }),
    });
    try {
      fake.files.set(paths.sockPath, "");
      fake.files.set(paths.pidPath, `${process.pid}\n`);
      const row = await probeDaemonStatus(host, "gptsovits");
      expect(row.state).toBe("warm");
      expect(row.pid).toBe(process.pid);
      expect(row.rssKb).toBe(5242880);
      expect(row.etime).toBe("03:12:45");
      expect(row.note).toContain("v=v2");
      expect(row.note).toContain("device=cpu");
      expect(fake.spawns.some((s) => s.cmd === "ps" && s.args.includes(String(process.pid)))).toBe(true);
    } finally {
      await daemon.close();
    }
  });

  it("stale：daemon 自述的权重指纹与磁盘现算不符，归因写明下次 kill 重拉", async () => {
    const { fake, host, paths } = harness();
    const daemon = await startFakeDaemon(paths.sockPath); // readyFrame 缺省 fp-current ≠ 现算指纹
    try {
      fake.files.set(paths.sockPath, "");
      const row = await probeDaemonStatus(host, "gptsovits");
      expect(row.state).toBe("stale");
      expect(row.note).toContain("版本键不符");
      expect(row.note).toContain("kill 重拉");
    } finally {
      await daemon.close();
    }
  });

  it("loading：bind 先于加载、pid 龄在引擎加载窗内，ls 不陪跑等满窗", async () => {
    const { fake, host, paths } = harness(`  204800  01:59\n`); // 119s < gptsovits 120s 窗
    const daemon = await startFakeDaemon(paths.sockPath, { ready: "none" });
    try {
      fake.files.set(paths.sockPath, "");
      fake.files.set(paths.pidPath, `${process.pid}\n`);
      const row = await probeDaemonStatus(host, "gptsovits", 150);
      expect(row.state).toBe("loading");
      expect(row.note).toContain("加载窗");
    } finally {
      await daemon.close();
    }
  });

  it("龄超加载窗的沉默 sock 判僵死 unreachable：loading 是窗内豁免不是无限背书", async () => {
    const { fake, host, paths } = harness(`  204800  02:01\n`); // 121s ≥ 120s 窗
    const daemon = await startFakeDaemon(paths.sockPath, { ready: "none" });
    try {
      fake.files.set(paths.sockPath, "");
      fake.files.set(paths.pidPath, `${process.pid}\n`);
      const row = await probeDaemonStatus(host, "gptsovits", 150);
      expect(row.state).toBe("unreachable");
      expect(row.note).toContain("僵死");
    } finally {
      await daemon.close();
    }
  });

  it("龄读数缺失（ps 失败）的沉默 sock 不谎报超窗：pid 在位豁免照给，判 loading", async () => {
    const { fake, host, paths } = harness(null); // ps 一律 exit 1：etime 无从折算
    const daemon = await startFakeDaemon(paths.sockPath, { ready: "none" });
    try {
      fake.files.set(paths.sockPath, "");
      fake.files.set(paths.pidPath, `${process.pid}\n`);
      const row = await probeDaemonStatus(host, "gptsovits", 150);
      expect(row.state).toBe("loading");
      expect(row.note).toContain("龄期读数缺失");
      expect(row.etime).toBeNull();
    } finally {
      await daemon.close();
    }
  });

  it("fatal 帧：daemon 加载失败自退中，归因指向本次合成降级", async () => {
    const { fake, host, paths } = harness();
    const daemon = await startFakeDaemon(paths.sockPath, {
      ready: `${JSON.stringify({ type: "fatal", message: "权重文件缺失" })}\n`,
    });
    try {
      fake.files.set(paths.sockPath, "");
      const row = await probeDaemonStatus(host, "gptsovits");
      expect(row.state).toBe("unreachable");
      expect(row.note).toContain("fatal");
      expect(row.note).toContain("权重文件缺失");
    } finally {
      await daemon.close();
    }
  });

  it("sock 注册在位而连接即错：unreachable 收编残file 形态，不试图清理", async () => {
    // 真残file（SIGKILL 后留下的 sock inode）实测回 ECONNREFUSED；这里以
    // 「files 表登记但磁盘无路径」复现连接出错面，两者在状态机上同为 unreachable
    const { fake, host, paths } = harness();
    fake.files.set(paths.sockPath, "");
    const row = await probeDaemonStatus(host, "gptsovits");
    expect(row.state).toBe("unreachable");
  });

  it("pid 文件在位但进程已死：warm 探测不受死 pid 拖累，表上 pid 归 null", async () => {
    const { fake, host, paths } = harness();
    const daemon = await startFakeDaemon(paths.sockPath, {
      ready: readyFrame({ version: "v2", weights_fingerprint: expectedDaemonVersionKey(paths.labDir).weightsFingerprint }),
    });
    try {
      fake.files.set(paths.sockPath, "");
      fake.files.set(paths.pidPath, "999999\n");
      const row = await probeDaemonStatus(host, "gptsovits");
      expect(row.state).toBe("warm");
      expect(row.pid).toBeNull();
      expect(fake.spawns).toEqual([]); // 死 pid 不该再花一次 ps
    } finally {
      await daemon.close();
    }
  });
});

describe("probeDaemonSock 传输面", () => {
  it("ready 前的引擎杂散行照单丢弃，不误判协议帧", async () => {
    const root = mkdtempSync(join(tmpdir(), "say-sock-probe-"));
    roots.push(root);
    const sockPath = join(root, "daemon.sock");
    const daemon = await startFakeDaemon(sockPath, { beforeReady: ["Loading checkpoint shards: 100%\n", "\n"] });
    try {
      const probe = await probeDaemonSock(sockPath, 1_000);
      expect(probe.kind).toBe("ready");
    } finally {
      await daemon.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ready 帧在多字节中间被分包切断仍完整归原：Buffer 累积按行切再解码", async () => {
    const root = mkdtempSync(join(tmpdir(), "say-sock-probe-"));
    roots.push(root);
    const sockPath = join(root, "daemon.sock");
    const frame = Buffer.from(`${JSON.stringify({ type: "ready", device: "苹果神经引擎", protocol: "2", version: "v2", weights_fingerprint: "fp" })}\n`, "utf8");
    const cut = frame.indexOf(Buffer.from("神", "utf8")) + 2; // 正好切进一个三字节字符的中间
    const daemon = await startFakeDaemon(sockPath, { writeChunks: [frame.subarray(0, cut), frame.subarray(cut)] });
    try {
      const probe = await probeDaemonSock(sockPath, 1_000);
      expect(probe.kind).toBe("ready");
      if (probe.kind === "ready") expect(probe.frame.device).toBe("苹果神经引擎");
    } finally {
      await daemon.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("无人应答超时归 timeout：观测面的秒级耗时承诺由调用方预算钉死", async () => {
    const root = mkdtempSync(join(tmpdir(), "say-sock-probe-"));
    roots.push(root);
    const sockPath = join(root, "daemon.sock");
    const daemon = await startFakeDaemon(sockPath, { ready: "none" });
    try {
      const t0 = Date.now();
      const probe = await probeDaemonSock(sockPath, 120);
      expect(probe.kind).toBe("timeout");
      expect(Date.now() - t0).toBeLessThan(1_000);
    } finally {
      await daemon.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
