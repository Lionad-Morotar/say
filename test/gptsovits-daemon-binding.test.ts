import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { createGptsovitsSynth, DAEMON_QUEUE_FULL_MESSAGE, type GptsovitsSynthRequest } from "../src/engines/gptsovits-binding.ts";
import { createGptsovitsEngine } from "../src/engines/gptsovits.ts";
import { GPTSOVITS_WEIGHT_MARKERS, weightsFingerprint } from "../src/engines/daemon-session.ts";
import type { EngineAdapter } from "../src/types.ts";
import { createFakeHost, type DaemonSpawnRecord, type FakeDaemonHandle } from "./fake-host.ts";
import { readyFrame, startFakeDaemon } from "./daemon-fakes.ts";

/**
 * daemon-first 接线的集成矩阵：daemon 走**进程内真 unix socket**（daemon-fakes 替身），
 * per-call 降级走 **FakeHost 管道**——两条传输面在同一断言里分流，
 * 检验 binding 的失败分级：基础设施失败降级重放、引擎级 error/fatal 帧直报不重放。
 */

const REQUEST: GptsovitsSynthRequest = {
  text: "你好，Lionad",
  refAudioPath: "/voices/frieren/ref.wav",
  promptText: "转写行",
  promptLang: "zh",
  textLang: "zh",
  speedFactor: 1.0,
};

/** 真实 tmp lab 目录：socket/pid 落点与权重指纹的磁盘投影都需要真 FS */
function withTempLab(run: (labDir: string, expectedFingerprint: string) => Promise<void>): Promise<void> {
  const labDir = mkdtempSync(join(tmpdir(), "say-db-"));
  // 落一枚安装 marker：期望指纹走非退化投影（missing 分支由指纹对拍套件覆盖，这里验实链路）
  const marker = join(labDir, GPTSOVITS_WEIGHT_MARKERS[0]!);
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, "");
  const fp = weightsFingerprint(labDir, GPTSOVITS_WEIGHT_MARKERS);
  return run(labDir, fp).finally(() => rmSync(labDir, { recursive: true, force: true }));
}

function specOf(labDir: string) {
  return { labDir, repoDir: `${labDir}/GPT-SoVITS`, pythonPath: "/usr/bin/env", shimPath: "/say-repo/scripts/shims/gptsovits-shim.py" };
}

/** per-call 降级面的 fake：daemon spawn 记录在案但永不 bind socket；per-call spawn 回 ready+audio */
function makePerCallCapableHost(options: { onDaemonSpawn?: (record: DaemonSpawnRecord) => void; files?: Record<string, string | Uint8Array> } = {}) {
  return createFakeHost({
    env: { HOME: "/h" },
    ...(options.files !== undefined ? { files: options.files } : {}),
    daemonFactory: (record) => {
      const isDaemon = record.args.includes("--daemon");
      if (isDaemon) options.onDaemonSpawn?.(record);
      const output = new PassThrough();
      if (!isDaemon) {
        output.write('{"type":"ready","engine":"gptsovits","version":"v2","device":"cpu"}\n');
      }
      return {
        output,
        errors: new PassThrough(),
        // exactOptionalPropertyTypes：onRequest 用展开缺席，不写 undefined
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

const FAST = { readyTimeoutMs: 120, warmTimeoutMs: 400, requestTimeoutMs: 1000, pollIntervalMs: 10 };

describe("createGptsovitsSynth：daemon-first 分流", () => {
  it("常驻 daemon 在位：合成经 socket 交付，零 per-call 进程拉起", async () => {
    await withTempLab(async (labDir, fp) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: readyFrame({ weights_fingerprint: fp }) });
      const fake = makePerCallCapableHost();
      try {
        const synth = createGptsovitsSynth(specOf(labDir), fake.host, FAST);
        const out = await synth(REQUEST);
        expect(out.sampleRate).toBe(32000);
        expect(Array.from(out.samples)).toEqual([0.5, -0.5]);
        const req = JSON.parse(daemon.requests[0]!) as Record<string, unknown>;
        expect(req.type).toBe("synthesize");
        expect(req.text).toBe("你好，Lionad");
        expect(req.ref_audio_path).toBe("/voices/frieren/ref.wav");
        expect(req.speed_factor).toBe(1.0);
        expect(fake.daemons).toHaveLength(0);
      } finally {
        await daemon.close();
      }
    });
  });

  it("两次合成复用同一握手连接：握手只付一次", async () => {
    await withTempLab(async (labDir, fp) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: readyFrame({ weights_fingerprint: fp }) });
      const fake = makePerCallCapableHost();
      try {
        const synth = createGptsovitsSynth(specOf(labDir), fake.host, FAST);
        await synth(REQUEST);
        await synth({ ...REQUEST, text: "第二句" });
        expect(daemon.connects).toBe(1);
        expect(daemon.requests).toHaveLength(2);
      } finally {
        await daemon.close();
      }
    });
  });

  it("daemon 不可达：lazy 拉起迟迟无 socket 后降级 per-call 出声，实例内不再重触 daemon", async () => {
    await withTempLab(async (labDir) => {
      const fake = makePerCallCapableHost();
      const synth = createGptsovitsSynth(specOf(labDir), fake.host, FAST);
      const out = await synth(REQUEST);
      expect(out.sampleRate).toBe(24000); // per-call 替身的采样率：出声即降级路径生效
      expect(fake.daemons).toHaveLength(2);
      expect(fake.daemons[0]!.args).toContain("--daemon"); // 第一条是常驻形态拉起
      expect(fake.daemons[1]!.args).not.toContain("--daemon"); // 第二条是 per-call 退路
      await synth(REQUEST); // sticky：本次调用不再触 daemon 重拉
      expect(fake.daemons).toHaveLength(2);
    });
  });

  it("在途 daemon 断连：同一请求经 per-call 重放出声，后续不再重连 daemon", async () => {
    await withTempLab(async (labDir, fp) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: readyFrame({ weights_fingerprint: fp }), onLine: "close" });
      const fake = makePerCallCapableHost();
      try {
        const synth = createGptsovitsSynth(specOf(labDir), fake.host, FAST);
        const out = await synth(REQUEST);
        expect(Array.from(out.samples)).toEqual([0.25]); // per-call 替身样本：EOF 后重放成功
        await synth({ ...REQUEST, text: "第二句" });
        expect(daemon.connects).toBe(1); // sticky 生效：断连后未再触 daemon
        const perCall = fake.daemonHandles.find((h) => h.requests.length > 0);
        expect(perCall?.requests).toHaveLength(2);
      } finally {
        await daemon.close();
      }
    });
  });

  it("daemon 请求超时：kill 后降级 per-call，超时请求不静默失踪", async () => {
    await withTempLab(async (labDir, fp) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: readyFrame({ weights_fingerprint: fp }), onLine: "ignore" });
      const fake = makePerCallCapableHost();
      try {
        const synth = createGptsovitsSynth(specOf(labDir), fake.host, { ...FAST, requestTimeoutMs: 120 });
        const out = await synth(REQUEST);
        expect(out.sampleRate).toBe(24000); // 降级重放出声
        expect(fake.daemons).toHaveLength(1); // per-call 会话在 timeout 后拉起
        expect(fake.daemons[0]!.args).not.toContain("--daemon");
      } finally {
        await daemon.close();
      }
    });
  });

  it("daemon 报 error 帧：EngineError 直报，不经 per-call 重放（同一请求必复现）", async () => {
    await withTempLab(async (labDir, fp) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: readyFrame({ weights_fingerprint: fp }), onLine: "error" });
      const fake = makePerCallCapableHost();
      try {
        const synth = createGptsovitsSynth(specOf(labDir), fake.host, FAST);
        await expect(synth(REQUEST)).rejects.toThrow(/参考音频损坏/);
        expect(fake.daemons).toHaveLength(0); // 引擎级失败：不付第二次进程成本
      } finally {
        await daemon.close();
      }
    });
  });

  it("daemon 队满拒转：按消息识别降级 per-call 出声，daemon 不判死、后续请求仍优先走常驻", async () => {
    await withTempLab(async (labDir, fp) => {
      let first = true;
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), {
        ready: readyFrame({ weights_fingerprint: fp }),
        onLine: (line, conn) => {
          const id = (JSON.parse(line) as { id: number }).id;
          if (first) {
            first = false;
            // 队满拒转形态：回 error 帧但不关连接（容量事件，非崩溃）
            conn.write(`${JSON.stringify({ type: "error", id, message: `${DAEMON_QUEUE_FULL_MESSAGE}（队列已满）` })}\n`);
          } else {
            const pcm = Buffer.alloc(4);
            pcm.writeInt16LE(16384, 0);
            conn.write(`${JSON.stringify({ type: "audio", id, pcm: pcm.toString("base64"), sample_rate: 32000, done: true })}\n`);
          }
        },
      });
      const fake = makePerCallCapableHost();
      try {
        const synth = createGptsovitsSynth(specOf(labDir), fake.host, FAST);
        const out1 = await synth(REQUEST);
        expect(out1.sampleRate).toBe(24000); // 首请求队满 → per-call 重放出声
        const out2 = await synth({ ...REQUEST, text: "第二句" });
        expect(out2.sampleRate).toBe(32000); // 次请求队已腾出 → 仍走常驻，sticky 未误置
        expect(daemon.connects).toBe(1); // 队满不 kill daemon：同一连接延续
      } finally {
        await daemon.close();
      }
    });
  });
});

describe("createGptsovitsEngine 默认接线（daemon-first 生效面）", () => {
  const VOICES = "/data/voices";
  const DEF = "/say-repo/assets/engines/gptsovits";
  const engineFiles = {
    [`${DEF}/default-zh.wav`]: "",
    [`${DEF}/default-zh.txt`]: "今天上海天气很好。\n",
    [`${DEF}/default-en.wav`]: "",
    [`${DEF}/default-en.txt`]: "This is a reference audio.\n",
  };

  function makeEngine(fake: ReturnType<typeof createFakeHost>, labDir: string): EngineAdapter {
    return createGptsovitsEngine({
      host: fake.host,
      labDir,
      voicesDir: VOICES,
      defaultVoiceDir: DEF,
      daemon: FAST, // 收窗计时：真机缺省 120s/60s，测试不能等
    });
  }

  it("不注入 synth：默认走常驻 daemon，请求经 socket 帧面完整", async () => {
    await withTempLab(async (labDir, fp) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: readyFrame({ weights_fingerprint: fp }) });
      const fake = createFakeHost({ env: { HOME: "/h" }, files: engineFiles, daemonFactory: () => null });
      try {
        const engine = makeEngine(fake, labDir);
        const out = await engine.speak("你好", { voice: null, rateWpm: 175, output: null });
        expect(out).toMatchObject({ type: "pcm", sampleRate: 32000 });
        const req = JSON.parse(daemon.requests[0]!) as Record<string, unknown>;
        expect(req.ref_audio_path).toBe(`${DEF}/default-zh.wav`);
        expect(req.text_lang).toBe("zh");
        expect(fake.daemons).toHaveLength(0); // daemon 命中：零 per-call 拉起
      } finally {
        await daemon.close();
      }
    });
  });

  it("daemon 拉起失败：speak 经 per-call 退路仍出声（默认接线的可用性保底）", async () => {
    await withTempLab(async (labDir) => {
      const fake = makePerCallCapableHost({ files: engineFiles });
      const engine = makeEngine(fake, labDir);
      const out = await engine.speak("你好", { voice: null, rateWpm: 175, output: null });
      expect(out).toMatchObject({ type: "pcm", sampleRate: 24000 });
      expect(fake.daemons[0]!.args).toContain("--daemon"); // 首选形态确实是常驻 daemon
      expect(fake.daemons[1]!.args).not.toContain("--daemon"); // 退路 per-call 兜住出声
    });
  });
});
