import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { createFireredSynth, type FireredSynthRequest } from "../src/engines/firered-binding.ts";
import { DAEMON_QUEUE_FULL_MESSAGE } from "../src/engines/gptsovits-binding.ts";
import { createFireredEngine } from "../src/engines/firered.ts";
import { FIRERED_WEIGHT_MARKERS, weightsFingerprint } from "../src/engines/daemon-session.ts";
import type { EngineAdapter } from "../src/types.ts";
import { createFakeHost, type DaemonSpawnRecord, type FakeDaemonHandle } from "./fake-host.ts";
import { readyFrame, startFakeDaemon } from "./daemon-fakes.ts";
import { CIRCUIT_COOLDOWN_MS, readCircuitRecord } from "../src/engines/daemon-circuit.ts";

/**
 * firered daemon-first 接线的集成矩阵（热启动 S5，gptsovits/indextts 钉版矩阵的同构镜像）：
 * daemon 走进程内真 unix socket（daemon-fakes 替身），per-call 降级走 FakeHost 管道——
 * 两条传输面在同一断言里分流，检验 binding 的失败分级与 firered 特有请求形态
 * （prompt_text 必带下传、24000 采样率、daemon spawn 携带 FIRERED_DEVICE env）。
 */

/** firered 侧 ready 帧：engine/version 与 shim 字面钉版一致，握手期望的比对对象 */
function fireredReady(over: Record<string, unknown> = {}): string {
  return readyFrame({ engine: "firered", version: "3", ...over });
}

const REQUEST: FireredSynthRequest = {
  text: "Hello Lionad, this is a warm daemon request",
  refAudioPath: "/voices/aria/ref.wav",
  promptText: "参考音频的转写文本",
  textLang: "en",
};

/** 真实 tmp lab 目录：socket/pid 落点与权重指纹的磁盘投影都需要真 FS */
function withTempLab(run: (labDir: string, expectedFingerprint: string) => Promise<void>): Promise<void> {
  const labDir = mkdtempSync(join(tmpdir(), "say-frb-"));
  // 落一枚投影清单文件：期望指纹走非退化投影（missing 分支由指纹对拍套件覆盖，这里验实链路）
  const marker = join(labDir, FIRERED_WEIGHT_MARKERS[0]!);
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, "");
  const fp = weightsFingerprint(labDir, FIRERED_WEIGHT_MARKERS);
  return run(labDir, fp).finally(() => rmSync(labDir, { recursive: true, force: true }));
}

function specOf(labDir: string) {
  return {
    labDir,
    repoDir: `${labDir}/FireRedTTS3`,
    modelsDir: `${labDir}/models/FireRedTTS3`,
    pythonPath: "/usr/bin/env",
    shimPath: "/say-repo/scripts/shims/firered-shim.py",
  };
}

/** per-call 降级面的 fake：daemon spawn 记录在案但永不 bind socket；per-call spawn 回 ready+audio */
function makePerCallCapableHost(options: { onDaemonSpawn?: (record: DaemonSpawnRecord) => void; files?: Record<string, string | Uint8Array>; env?: Record<string, string>; now?: () => number } = {}) {
  return createFakeHost({
    env: { HOME: "/h", ...(options.env ?? {}) },
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.files !== undefined ? { files: options.files } : {}),
    daemonFactory: (record) => {
      const isDaemon = record.args.includes("--daemon");
      if (isDaemon) options.onDaemonSpawn?.(record);
      const output = new PassThrough();
      if (!isDaemon) {
        output.write('{"type":"ready","engine":"firered","version":"3","device":"mps"}\n');
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

describe("createFireredSynth：daemon-first 分流", () => {
  it("常驻 daemon 在位：合成经 socket 交付，零 per-call 进程拉起，prompt_text 与语言下传完整", async () => {
    await withTempLab(async (labDir, fp) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: fireredReady({ weights_fingerprint: fp }) });
      const fake = makePerCallCapableHost();
      try {
        const synth = createFireredSynth(specOf(labDir), fake.host, FAST);
        const out = await synth(REQUEST);
        expect(out.sampleRate).toBe(32000);
        expect(Array.from(out.samples)).toEqual([0.5, -0.5]);
        const req = JSON.parse(daemon.requests[0]!) as Record<string, unknown>;
        expect(req.type).toBe("synthesize");
        expect(req.text).toBe(REQUEST.text);
        expect(req.ref_audio_path).toBe("/voices/aria/ref.wav");
        expect(req.prompt_text).toBe("参考音频的转写文本"); // FireRed 克隆质量承重字段
        expect(req.text_lang).toBe("en");
        expect(fake.daemons).toHaveLength(0);
      } finally {
        await daemon.close();
      }
    });
  });

  it("两次合成复用同一握手连接：握手只付一次", async () => {
    await withTempLab(async (labDir, fp) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: fireredReady({ weights_fingerprint: fp }) });
      const fake = makePerCallCapableHost();
      try {
        const synth = createFireredSynth(specOf(labDir), fake.host, FAST);
        await synth(REQUEST);
        await synth({ ...REQUEST, text: "Second line" });
        expect(daemon.connects).toBe(1);
        expect(daemon.requests).toHaveLength(2);
      } finally {
        await daemon.close();
      }
    });
  });

  it("daemon 不可达：lazy 拉起迟迟无 socket 后降级 per-call 出声，拉起带 FIRERED_DEVICE env 与钉版 idle", async () => {
    await withTempLab(async (labDir) => {
      const fake = makePerCallCapableHost({ env: { FIRERED_DEVICE: "cpu" } });
      const synth = createFireredSynth(specOf(labDir), fake.host, FAST);
      const out = await synth(REQUEST);
      expect(out.sampleRate).toBe(24000); // per-call 替身的采样率：出声即降级路径生效
      expect(fake.daemons).toHaveLength(2);
      expect(fake.daemons[0]!.args).toContain("--daemon"); // 第一条是常驻形态拉起
      expect(fake.daemons[0]!.args).toContain("--models"); // firered 拉起参数带 pretrained_model_dir
      expect(fake.daemons[0]!.args).toContain("--idle-minutes"); // 票 03：firered 档 5 分钟
      expect(fake.daemons[0]!.args).toContain("5");
      expect(fake.daemons[0]!.env).toEqual({ FIRERED_DEVICE: "cpu" }); // daemon 进程与 per-call 同设备链
      expect(fake.daemons[1]!.args).not.toContain("--daemon"); // 第二条是 per-call 退路
      await synth(REQUEST); // sticky：本次调用不再触 daemon 重拉
      expect(fake.daemons).toHaveLength(2);
    });
  });

  it("daemon spawn env 缺省 darwin 走 mps（fireredDevice 解析链与 per-call 同源）", async () => {
    await withTempLab(async (labDir) => {
      const fake = makePerCallCapableHost();
      const synth = createFireredSynth(specOf(labDir), fake.host, FAST);
      await synth(REQUEST).catch(() => undefined);
      const daemonSpawn = fake.daemons.find((d) => d.args.includes("--daemon"));
      if (process.platform === "darwin") expect(daemonSpawn?.env).toEqual({ FIRERED_DEVICE: "mps" });
      else expect(daemonSpawn?.env).toEqual({ FIRERED_DEVICE: "cpu" });
    });
  });

  it("在途 daemon 断连：同一请求经 per-call 重放出声，后续不再重连 daemon", async () => {
    await withTempLab(async (labDir, fp) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: fireredReady({ weights_fingerprint: fp }), onLine: "close" });
      const fake = makePerCallCapableHost();
      try {
        const synth = createFireredSynth(specOf(labDir), fake.host, FAST);
        const out = await synth(REQUEST);
        expect(Array.from(out.samples)).toEqual([0.25]); // per-call 替身样本：EOF 后重放成功
        await synth({ ...REQUEST, text: "Second line" });
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
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: fireredReady({ weights_fingerprint: fp }), onLine: "ignore" });
      const fake = makePerCallCapableHost();
      try {
        const synth = createFireredSynth(specOf(labDir), fake.host, { ...FAST, requestTimeoutMs: 120 });
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
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: fireredReady({ weights_fingerprint: fp }), onLine: "error" });
      const fake = makePerCallCapableHost();
      try {
        const synth = createFireredSynth(specOf(labDir), fake.host, FAST);
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
        ready: fireredReady({ weights_fingerprint: fp }),
        onLine: (line, conn) => {
          const id = (JSON.parse(line) as { id: number }).id;
          if (first) {
            first = false;
            conn.write(`${JSON.stringify({ type: "error", id, message: `${DAEMON_QUEUE_FULL_MESSAGE}（队列已满）` })}\n`);
          } else {
            const pcm = Buffer.alloc(4);
            pcm.writeInt16LE(16384, 0);
            pcm.writeInt16LE(-16384, 2);
            conn.write(`${JSON.stringify({ type: "audio", id, pcm: pcm.toString("base64"), sample_rate: 32000, done: true })}\n`);
          }
        },
      });
      const fake = makePerCallCapableHost();
      try {
        const synth = createFireredSynth(specOf(labDir), fake.host, FAST);
        const out1 = await synth(REQUEST);
        expect(out1.sampleRate).toBe(24000); // 首请求队满 → per-call 重放出声
        const out2 = await synth({ ...REQUEST, text: "Second line" });
        expect(out2.sampleRate).toBe(32000); // 次请求队已腾出 → 仍走常驻，sticky 未误置
        expect(daemon.connects).toBe(1); // 队满不 kill daemon：同一连接延续
      } finally {
        await daemon.close();
      }
    });
  });

  it("版本键不符（旧代码 daemon）：kill 重拉一次后仍不符则降级 per-call", async () => {
    await withTempLab(async (labDir) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: fireredReady({ weights_fingerprint: "fp-stale-old-daemon" }) });
      const fake = makePerCallCapableHost();
      try {
        const synth = createFireredSynth(specOf(labDir), fake.host, FAST);
        const out = await synth(REQUEST);
        expect(out.sampleRate).toBe(24000); // 过期 daemon 被拒，per-call 兜底出声
        expect(daemon.connects).toBeGreaterThanOrEqual(1);
      } finally {
        await daemon.close();
      }
    });
  });
});

describe("createFireredEngine 默认接线（daemon-first 生效面）", () => {
  const VOICES = "/data/voices";

  function makeEngine(fake: ReturnType<typeof createFakeHost>, labDir: string): EngineAdapter {
    return createFireredEngine({
      host: fake.host,
      labDir,
      voicesDir: VOICES,
      daemon: FAST, // 收窗计时：真机缺省 240s/60s，测试不能等
    });
  }

  it("不注入 synth：默认走常驻 daemon，请求经 socket 帧面完整（参考转写与语言下传）", async () => {
    await withTempLab(async (labDir, fp) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: fireredReady({ weights_fingerprint: fp }) });
      const fake = createFakeHost({ env: { HOME: "/h" }, daemonFactory: () => null });
      try {
        const engine = makeEngine(fake, labDir);
        const out = await engine.speak("Hello world", { voice: null, rateWpm: 175, output: null });
        expect(out).toMatchObject({ type: "pcm", sampleRate: 32000 });
        const req = JSON.parse(daemon.requests[0]!) as Record<string, unknown>;
        expect(req.ref_audio_path).toBe(`${labDir}/prompts/prompt_2.wav`); // default 嗓官方参考
        expect(req.prompt_text).toBe("对，所以说你现在的话，这个账单的话，你既然说能处理，那你就想办法处理掉。");
        expect(req.text_lang).toBe("en");
        expect(fake.daemons).toHaveLength(0); // daemon 命中：零 per-call 拉起
      } finally {
        await daemon.close();
      }
    });
  });

  it("daemon 拉起失败：speak 经 per-call 退路仍出声（默认接线的可用性保底）", async () => {
    await withTempLab(async (labDir) => {
      const fake = makePerCallCapableHost();
      const engine = makeEngine(fake, labDir);
      const out = await engine.speak("Hello world", { voice: null, rateWpm: 175, output: null });
      expect(out).toMatchObject({ type: "pcm", sampleRate: 24000 });
      expect(fake.daemons[0]!.args).toContain("--daemon"); // 首选形态确实是常驻 daemon
      expect(fake.daemons[1]!.args).not.toContain("--daemon"); // 退路 per-call 兜住出声
    });
  });
});

describe("daemon 熔断（firered 装配面）：daemon-failures 跨调用闸住拉起", () => {
  function circuitPathOf(labDir: string): string {
    return join(labDir, "daemon-failures");
  }

  it("三次连续拉起失败开窗：第四次不再触 daemon，直接 per-call 出声", async () => {
    await withTempLab(async (labDir) => {
      const clock = { t: 5_000_000 };
      const fake = makePerCallCapableHost({ now: () => clock.t });
      for (let i = 0; i < 3; i += 1) {
        const synth = createFireredSynth(specOf(labDir), fake.host, FAST);
        expect((await synth(REQUEST)).sampleRate).toBe(24000); // 每轮都经 per-call 退路出声
      }
      const opened = readCircuitRecord(circuitPathOf(labDir));
      expect(opened?.openedAt).toBe(clock.t); // 第三次失败即开窗（票 04：3 次进冷却）
      const synth4 = createFireredSynth(specOf(labDir), fake.host, FAST);
      expect((await synth4(REQUEST)).sampleRate).toBe(24000); // 冷却期内 daemon 完全不碰
      expect(fake.daemons.filter((d) => d.args.includes("--daemon"))).toHaveLength(3); // 零新拉起：比降级更省
    });
  });

  it("成功温态合成清零计数（删文件）", async () => {
    await withTempLab(async (labDir, fp) => {
      const clock = { t: 5_000_000 };
      writeFileSync(circuitPathOf(labDir), JSON.stringify({ count: 2, lastAt: clock.t, openedAt: null }));
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: fireredReady({ weights_fingerprint: fp }) });
      const fake = makePerCallCapableHost({ now: () => clock.t });
      try {
        const synth = createFireredSynth(specOf(labDir), fake.host, FAST);
        expect((await synth(REQUEST)).sampleRate).toBe(32000);
        expect(readCircuitRecord(circuitPathOf(labDir))?.count).toBe(0); // 温态成功抹掉劣化史：下一次失败从头计
        await daemon.close();
      } finally {
        void fake;
      }
    });
  });

  it("冷却到期放行：daemon-first 恢复，成功合成把计数文件写没", async () => {
    await withTempLab(async (labDir, fp) => {
      const clock = { t: 5_000_000 };
      writeFileSync(circuitPathOf(labDir), JSON.stringify({ count: 3, lastAt: clock.t - CIRCUIT_COOLDOWN_MS - 1, openedAt: clock.t - CIRCUIT_COOLDOWN_MS - 1 }));
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: fireredReady({ weights_fingerprint: fp }) });
      const fake = makePerCallCapableHost({ now: () => clock.t });
      try {
        const synth = createFireredSynth(specOf(labDir), fake.host, FAST);
        expect((await synth(REQUEST)).sampleRate).toBe(32000); // 到期给一次重试机会且成功
        expect(readCircuitRecord(circuitPathOf(labDir))?.count).toBe(0);
        await daemon.close();
      } finally {
        void fake;
      }
    });
  });
});

describe("SAY_DAEMON 逃生门（firered 装配面）", () => {
  const VOICES = "/data/voices";

  function speakThrough(fakeHost: ReturnType<typeof createFakeHost>, labDir: string): Promise<{ type: string; sampleRate: number }> {
    const engine = createFireredEngine({ host: fakeHost.host, labDir, voicesDir: VOICES, daemon: FAST });
    return engine.speak("Hello world", { voice: null, rateWpm: 175, output: null }) as Promise<{ type: string; sampleRate: number }>;
  }

  it("off：daemon 面零接触（健康 daemon 在位也不连），直接 per-call，与 daemon 上线前行为同形", async () => {
    await withTempLab(async (labDir, fp) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: fireredReady({ weights_fingerprint: fp }) });
      const fake = makePerCallCapableHost({ env: { SAY_DAEMON: "off" } });
      try {
        const out = await speakThrough(fake, labDir);
        expect(out.sampleRate).toBe(24000); // per-call 面出声
        expect(daemon.connects).toBe(0); // 连都不连
        expect(fake.daemons).toHaveLength(1);
        expect(fake.daemons[0]!.args).not.toContain("--daemon"); // 只有 per-call 形态拉起
        expect(existsSync(join(labDir, "daemon-failures"))).toBe(false); // off 不是失败：不进熔断
      } finally {
        await daemon.close();
      }
    });
  });

  it("on 显式值与缺省同义：daemon-first 照常", async () => {
    await withTempLab(async (labDir, fp) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: fireredReady({ weights_fingerprint: fp }) });
      const fake = makePerCallCapableHost({ env: { SAY_DAEMON: "on" } });
      try {
        const out = await speakThrough(fake, labDir);
        expect(out.sampleRate).toBe(32000);
        expect(fake.stderr.join("")).not.toContain("SAY_DAEMON"); // 合法值不该有警告噪音
      } finally {
        await daemon.close();
      }
    });
  });

  it("坏值降级：按 on 处理并 stderr 警告（环境层 typo 不该瘫痪出声下限）", async () => {
    await withTempLab(async (labDir, fp) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: fireredReady({ weights_fingerprint: fp }) });
      const fake = makePerCallCapableHost({ env: { SAY_DAEMON: "banana" } });
      try {
        const out = await speakThrough(fake, labDir);
        expect(out.sampleRate).toBe(32000);
        expect(fake.stderr.join("")).toContain("SAY_DAEMON");
      } finally {
        await daemon.close();
      }
    });
  });
});
