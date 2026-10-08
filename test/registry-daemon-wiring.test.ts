import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { createDefaultRegistry } from "../src/engines/index.ts";
import { GPTSOVITS_WEIGHT_MARKERS, weightsFingerprint } from "../src/engines/daemon-session.ts";
import type { ConfigFile } from "../src/types.ts";
import { createFakeHost, type FakeDaemonHandle } from "./fake-host.ts";
import { readyFrame, startFakeDaemon, type FakeDaemon } from "./daemon-fakes.ts";

/**
 * [daemon] 三层的接线面验收：resolveDaemonConfig 是纯函数，工厂回退是 env-only——
 * config 层要在真链路生效，全靠 createDefaultRegistry 把落盘配置投影成 daemonSettings 注入。
 * 本套件用 spawn 形态（连 socket = daemon 命中 / 拉起 per-call = 门关）作可观测判据，
 * 钉住「daemonFile 被接上」与「警告单源一次」两件工厂级测试覆盖不到的事。
 */

/** 随仓 default 嗓参考目录：注册表装配的引擎用它，fake files 表按同一实路径补参考对 */
const DEF = join(import.meta.dirname, "../assets/engines/gptsovits");
const engineFiles = {
  [`${DEF}/default-zh.wav`]: "",
  [`${DEF}/default-zh.txt`]: "今天上海天气很好。\n",
  [`${DEF}/default-en.wav`]: "",
  [`${DEF}/default-en.txt`]: "This is a reference audio.\n",
};

/** per-call 可出声的假宿主：--daemon 拉起记录在案但永不 bind socket，per-call 回 ready+audio */
function makePerCallCapableHost(options: { files?: Record<string, string | Uint8Array>; env?: Record<string, string> } = {}) {
  return createFakeHost({
    env: { HOME: "/h", ...(options.env ?? {}) },
    ...(options.files !== undefined ? { files: options.files } : {}),
    daemonFactory: (record) => {
      const isDaemon = record.args.includes("--daemon");
      const output = new PassThrough();
      if (!isDaemon) {
        output.write('{"type":"ready","engine":"gptsovits","version":"v2","device":"cpu"}\n');
      }
      return {
        output,
        errors: new PassThrough(),
        ...(isDaemon
          ? {}
          : {
              onRequest: (line: string, handle: FakeDaemonHandle) => {
                const id = (JSON.parse(line) as { id: number }).id;
                const pcm = Buffer.alloc(2);
                pcm.writeInt16LE(8192);
                handle.output.write(`${JSON.stringify({ type: "audio", id, pcm: pcm.toString("base64"), sample_rate: 24000, done: true })}\n`);
              },
            }),
      };
    },
  });
}

/** 真 tmp XDG_DATA_HOME：注册表按 env 推导 labDir，socket 与权重指纹都要真磁盘 */
async function withTempDataHome(run: (dataDir: string, labDir: string, fp: string) => Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "say-reg-daemon-"));
  const labDir = join(dataDir, "say-lab", "gptsovits");
  const marker = join(labDir, GPTSOVITS_WEIGHT_MARKERS[0]!);
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, "");
  const fp = weightsFingerprint(labDir, GPTSOVITS_WEIGHT_MARKERS);
  try {
    await run(dataDir, labDir, fp);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/** 经注册表取 gptsovits 引擎出声：返回值形态（32000=daemon socket 帧，24000=per-call 帧）即门的状态 */
async function speakThroughRegistry(fake: ReturnType<typeof createFakeHost>, daemonFile: ConfigFile | null): Promise<{ type: string; sampleRate: number }> {
  const registry = createDefaultRegistry(fake.host, { daemonFile });
  const engine = registry.get("gptsovits")!;
  return (await engine.speak("你好", { voice: null, rateWpm: 175, output: null })) as { type: string; sampleRate: number };
}

describe("createDefaultRegistry daemon 接线（config 层在真链路生效）", () => {
  it("daemonFile enabled=false 关门：健康 daemon 在位也不连，直接 per-call", async () => {
    await withTempDataHome(async (dataDir, labDir, fp) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: readyFrame({ weights_fingerprint: fp }) });
      const fake = makePerCallCapableHost({ files: engineFiles, env: { XDG_DATA_HOME: dataDir } });
      try {
        const out = await speakThroughRegistry(fake, { daemon: { enabled: false } });
        expect(out.sampleRate).toBe(24000);
        expect(daemon.connects).toBe(0);
        expect(fake.daemons).toHaveLength(1);
        expect(fake.daemons[0]!.args).not.toContain("--daemon");
      } finally {
        await daemon.close();
      }
    });
  });

  it("env SAY_DAEMON=off 压过 config enabled=true：三层序在接线面成立", async () => {
    await withTempDataHome(async (dataDir, labDir, fp) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: readyFrame({ weights_fingerprint: fp }) });
      const fake = makePerCallCapableHost({ files: engineFiles, env: { XDG_DATA_HOME: dataDir, SAY_DAEMON: "off" } });
      try {
        const out = await speakThroughRegistry(fake, { daemon: { enabled: true } });
        expect(out.sampleRate).toBe(24000);
        expect(daemon.connects).toBe(0);
      } finally {
        await daemon.close();
      }
    });
  });

  it("config enabled=false 被 env on 压回：daemon-first 照常连常驻", async () => {
    await withTempDataHome(async (dataDir, labDir, fp) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: readyFrame({ weights_fingerprint: fp }) });
      const fake = makePerCallCapableHost({ files: engineFiles, env: { XDG_DATA_HOME: dataDir, SAY_DAEMON: "on" } });
      try {
        const out = await speakThroughRegistry(fake, { daemon: { enabled: false } });
        expect(out.sampleRate).toBe(32000);
        expect(fake.daemons).toHaveLength(0);
      } finally {
        await daemon.close();
      }
    });
  });

  it("三层全缺席保持 daemon-first 缺省：接线不改变上线前形态", async () => {
    await withTempDataHome(async (dataDir, labDir, fp) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: readyFrame({ weights_fingerprint: fp }) });
      const fake = makePerCallCapableHost({ files: engineFiles, env: { XDG_DATA_HOME: dataDir } });
      try {
        const out = await speakThroughRegistry(fake, null);
        expect(out.sampleRate).toBe(32000);
        expect(fake.daemons).toHaveLength(0);
        expect(fake.stderr.join("")).toBe(""); // 无坏值不该有任何警告噪音
      } finally {
        await daemon.close();
      }
    });
  });

  it("per-engine idle 表经接线落到 daemon 拉起参数：--idle-minutes 收 config 值而非内置档", async () => {
    await withTempDataHome(async (dataDir, labDir, fp) => {
      // daemon 拉起即场 bind socket：session 的 200ms 可连轮询随即命中 ready 握手，
      // 观测拉起参数行不必等 120s ready 超时
      const daemonRef: { up: Promise<FakeDaemon> | null } = { up: null };
      const fake = createFakeHost({
        env: { HOME: "/h", XDG_DATA_HOME: dataDir },
        files: engineFiles,
        daemonFactory: (record) => {
          if (record.args.includes("--daemon") && daemonRef.up === null) {
            daemonRef.up = startFakeDaemon(join(labDir, "daemon.sock"), { ready: readyFrame({ weights_fingerprint: fp }) });
          }
          return { output: new PassThrough(), errors: new PassThrough() };
        },
      });
      try {
        const out = await speakThroughRegistry(fake, { daemon: { idle: { gptsovits: 3 } } });
        expect(out.sampleRate).toBe(32000); // daemon 命中：观测的是拉起尝试，不经 per-call 退路
        const daemonSpawn = fake.daemons.find((record) => record.args.includes("--daemon"))!;
        const idx = daemonSpawn.args.indexOf("--idle-minutes");
        expect(daemonSpawn.args[idx + 1]).toBe("3"); // config [daemon.idle] 胜出自内置表 15
      } finally {
        if (daemonRef.up !== null) await (await daemonRef.up).close();
      }
    });
  });

  it("坏 SAY_DAEMON 单源归因：一次调用一行警告，config 层照常胜出", async () => {
    await withTempDataHome(async (dataDir, labDir, fp) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: readyFrame({ weights_fingerprint: fp }) });
      const fake = makePerCallCapableHost({ files: engineFiles, env: { XDG_DATA_HOME: dataDir, SAY_DAEMON: "banana" } });
      try {
        const out = await speakThroughRegistry(fake, { daemon: { enabled: false } });
        expect(out.sampleRate).toBe(24000); // 非法 env 跳层，config 的 false 生效
        const hits = fake.stderr.filter((line) => line.includes("SAY_DAEMON"));
        expect(hits).toHaveLength(1); // 旧形态逐引擎各打一份，四引擎刷四行同文
      } finally {
        await daemon.close();
      }
    });
  });
});
