import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { createVoxcpmSynth, type VoxcpmSynthRequest } from "../src/engines/voxcpm-binding.ts";
import { DAEMON_QUEUE_FULL_MESSAGE } from "../src/engines/gptsovits-binding.ts";
import { createVoxcpmEngine } from "../src/engines/voxcpm.ts";
import { VOXCPM_WEIGHT_MARKERS, weightsFingerprint } from "../src/engines/daemon-session.ts";
import type { EngineAdapter } from "../src/types.ts";
import { createFakeHost, type DaemonSpawnRecord, type FakeDaemonHandle } from "./fake-host.ts";
import { readyFrame, startFakeDaemon } from "./daemon-fakes.ts";
import { CIRCUIT_COOLDOWN_MS, readCircuitRecord } from "../src/engines/daemon-circuit.ts";

/**
 * voxcpm daemon-first 接线的集成矩阵（热启动 S5，firered/indextts 钉版矩阵的流式变体）：
 * daemon 走进程内真 unix socket（daemon-fakes 替身），per-call 降级走 FakeHost 管道。
 * 与整句矩阵的本质差异是 D4 划界面的双分支钉死：首帧前基础设施失败经 per-call 重放
 * 消费无感，首帧后在途断连不可重放（半截音频已出声，重放即重复前缀）按引擎级失败抛出。
 * 流式帧序（中间帧 done=false + 尾帧 done=true）在 daemon 路径上逐帧交付亦是独有断言面。
 */

/** voxcpm 侧 ready 帧：engine/version 与握手期望（运行时类名钉版）一致，比对对象 */
function voxcpmReady(over: Record<string, unknown> = {}): string {
  return readyFrame({ engine: "voxcpm", version: "VoxCPM2Model", ...over });
}

const REQUEST: VoxcpmSynthRequest = {
  text: "你好 Lionad，这是热 daemon 流式请求",
  refAudioPath: "/voices/aria/ref.wav",
  promptText: "参考音频的转写文本",
  control: null,
};

/** 真实 tmp lab 目录：socket/pid 落点与权重指纹的磁盘投影都需要真 FS */
function withTempLab(run: (labDir: string, expectedFingerprint: string) => Promise<void>): Promise<void> {
  const labDir = mkdtempSync(join(tmpdir(), "say-vxcb-"));
  const marker = join(labDir, VOXCPM_WEIGHT_MARKERS[0]!);
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, "");
  const fp = weightsFingerprint(labDir, VOXCPM_WEIGHT_MARKERS);
  return run(labDir, fp).finally(() => rmSync(labDir, { recursive: true, force: true }));
}

function specOf(labDir: string) {
  return {
    labDir,
    modelsDir: `${labDir}/models`,
    pythonPath: "/usr/bin/env",
    shimPath: "/say-repo/scripts/shims/voxcpm-shim.py",
  };
}

/**
 * per-call 降级面的 fake：daemon spawn 记录在案但永不 bind socket；
 * per-call spawn 回 ready + 两帧流式（48000 采样率——与 daemon fake 的 32000 单帧区分，
 * 消费侧见 48000 即知走了 per-call 重放路径）。
 */
function makePerCallCapableHost(options: { onDaemonSpawn?: (record: DaemonSpawnRecord) => void; env?: Record<string, string>; now?: () => number } = {}) {
  return createFakeHost({
    env: { HOME: "/h", ...(options.env ?? {}) },
    ...(options.now !== undefined ? { now: options.now } : {}),
    daemonFactory: (record) => {
      const isDaemon = record.args.includes("--daemon");
      if (isDaemon) options.onDaemonSpawn?.(record);
      const output = new PassThrough();
      if (!isDaemon) {
        output.write('{"type":"ready","engine":"voxcpm","version":"VoxCPM2Model","device":"mps"}\n');
      }
      return {
        output,
        errors: new PassThrough(),
        ...(isDaemon
          ? {}
          : {
              onRequest: (line: string, handle: FakeDaemonHandle) => {
                const id = (JSON.parse(line) as { id: number }).id;
                const a = Buffer.alloc(2);
                a.writeInt16LE(8192);
                const b = Buffer.alloc(2);
                b.writeInt16LE(-8192);
                handle.output.write(`${JSON.stringify({ type: "audio", id, pcm: a.toString("base64"), sample_rate: 48000, done: false })}\n`);
                handle.output.write(`${JSON.stringify({ type: "audio", id, pcm: b.toString("base64"), sample_rate: 48000, done: true })}\n`);
              },
            }),
      };
    },
  });
}

/** 消费流式 synth 到终结，收全部块 */
async function collect(synth: AsyncIterable<{ samples: Float32Array; sampleRate: number; done: boolean }>): Promise<{ chunks: number; sampleRate: number; samples: number[] }> {
  const samples: number[] = [];
  let chunks = 0;
  let sampleRate = 0;
  for await (const chunk of synth) {
    chunks += 1;
    sampleRate = chunk.sampleRate;
    samples.push(...chunk.samples);
    if (chunk.done) break;
  }
  return { chunks, sampleRate, samples };
}

const FAST = { readyTimeoutMs: 120, warmTimeoutMs: 400, requestTimeoutMs: 1000, pollIntervalMs: 10 };

describe("createVoxcpmSynth：daemon-first 流式分流", () => {
  it("常驻 daemon 在位：块经 socket 逐帧交付，零 per-call 拉起，克隆对字段下传完整", async () => {
    await withTempLab(async (labDir, fp) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: voxcpmReady({ weights_fingerprint: fp }) });
      const fake = makePerCallCapableHost();
      try {
        const synth = createVoxcpmSynth(specOf(labDir), fake.host, FAST);
        const out = await collect(synth(REQUEST));
        expect(out.sampleRate).toBe(32000);
        expect(out.samples).toEqual([0.5, -0.5]);
        const req = JSON.parse(daemon.requests[0]!) as Record<string, unknown>;
        expect(req.text).toBe(REQUEST.text);
        expect(req.ref_audio_path).toBe("/voices/aria/ref.wav");
        expect(req.prompt_text).toBe("参考音频的转写文本");
        expect(req.control).toBeUndefined(); // control null：缺席不写键（voice creation 判据）
        expect(fake.daemons).toHaveLength(0);
      } finally {
        await daemon.close();
      }
    });
  });

  it("control 指令下传：voice creation 的嗓形态经协议 control 字段完整到达 daemon", async () => {
    await withTempLab(async (labDir, fp) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: voxcpmReady({ weights_fingerprint: fp }) });
      const fake = makePerCallCapableHost();
      try {
        const synth = createVoxcpmSynth(specOf(labDir), fake.host, FAST);
        await collect(synth({ ...REQUEST, refAudioPath: null, promptText: null, control: "A warm female voice" }));
        const req = JSON.parse(daemon.requests[0]!) as Record<string, unknown>;
        expect(req.control).toBe("A warm female voice");
        expect(req.ref_audio_path).toBe(""); // 协议通用字段空串占位（per-call 同形态）
      } finally {
        await daemon.close();
      }
    });
  });

  it("daemon 帧序透传：中间帧 done=false 逐块交付、done 尾帧终结，两次合成复用同一连接", async () => {
    await withTempLab(async (labDir, fp) => {
      let first = true;
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), {
        ready: voxcpmReady({ weights_fingerprint: fp }),
        onLine: (line, conn) => {
          const id = (JSON.parse(line) as { id: number }).id;
          const mk = (n: number, done: boolean) => {
            const pcm = Buffer.alloc(2);
            pcm.writeInt16LE(n);
            return `${JSON.stringify({ type: "audio", id, pcm: pcm.toString("base64"), sample_rate: 32000, done })}\n`;
          };
          if (first) {
            first = false;
            conn.write(mk(4096, false));
            conn.write(mk(-4096, false));
            conn.write(mk(8192, true));
          } else {
            conn.write(mk(4096, true));
          }
        },
      });
      const fake = makePerCallCapableHost();
      try {
        const synth = createVoxcpmSynth(specOf(labDir), fake.host, FAST);
        const out1 = await collect(synth(REQUEST));
        expect(out1.chunks).toBe(3);
        expect(out1.samples).toEqual([0.125, -0.125, 0.25]); // 三块逐帧交付，非整句拼接
        const out2 = await collect(synth({ ...REQUEST, text: "第二句" }));
        expect(out2.chunks).toBe(1);
        expect(daemon.connects).toBe(1); // 握手只付一次
        expect(daemon.requests).toHaveLength(2);
      } finally {
        await daemon.close();
      }
    });
  });

  it("两次合成复用同一握手连接：连接数不变", async () => {
    await withTempLab(async (labDir, fp) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: voxcpmReady({ weights_fingerprint: fp }) });
      const fake = makePerCallCapableHost();
      try {
        const synth = createVoxcpmSynth(specOf(labDir), fake.host, FAST);
        await collect(synth(REQUEST));
        await collect(synth({ ...REQUEST, text: "Second line" }));
        expect(daemon.connects).toBe(1);
      } finally {
        await daemon.close();
      }
    });
  });

  it("daemon 不可达：lazy 拉起迟迟无 socket 后降级 per-call 出声，拉起带 --lab 与钉版 idle 15", async () => {
    await withTempLab(async (labDir) => {
      const fake = makePerCallCapableHost();
      const synth = createVoxcpmSynth(specOf(labDir), fake.host, FAST);
      const out = await collect(synth(REQUEST));
      expect(out.sampleRate).toBe(48000); // per-call 流式替身：降级路径生效
      expect(out.chunks).toBe(2);
      expect(fake.daemons).toHaveLength(2);
      expect(fake.daemons[0]!.args).toContain("--daemon");
      expect(fake.daemons[0]!.args).toContain("--lab"); // daemon 形态显式 lab 根（sock/pid/指纹落点）
      expect(fake.daemons[0]!.args).toContain("--idle-minutes");
      expect(fake.daemons[0]!.args).toContain("15"); // 票 03：voxcpm 档 15 分钟
      expect(fake.daemons[0]!.env).toBeUndefined(); // voxcpm 无设备 env 注入面（引擎 auto 分派）
      expect(fake.daemons[1]!.args).not.toContain("--daemon"); // 第二条是 per-call 退路
      await collect(synth(REQUEST)); // sticky：本次调用不再触 daemon 重拉
      expect(fake.daemons).toHaveLength(2);
    });
  });

  it("首帧前在途 EOF：同一请求经 per-call 重放出声（消费方只看见块，不见失败），后续不再重连 daemon", async () => {
    await withTempLab(async (labDir, fp) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: voxcpmReady({ weights_fingerprint: fp }), onLine: "close" });
      const fake = makePerCallCapableHost();
      try {
        const synth = createVoxcpmSynth(specOf(labDir), fake.host, FAST);
        const out = await collect(synth(REQUEST));
        expect(out.sampleRate).toBe(48000); // 重放成功
        await collect(synth({ ...REQUEST, text: "Second line" }));
        expect(daemon.connects).toBe(1); // sticky 生效
        const perCall = fake.daemonHandles.find((h) => h.requests.length > 0);
        expect(perCall?.requests).toHaveLength(2);
      } finally {
        await daemon.close();
      }
    });
  });

  it("首帧后在途断连：已出声不可重放，按引擎级失败抛出且不触碰 per-call（D4 划界钉死）", async () => {
    await withTempLab(async (labDir, fp) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), {
        ready: voxcpmReady({ weights_fingerprint: fp }),
        onLine: (line, conn) => {
          const id = (JSON.parse(line) as { id: number }).id;
          const pcm = Buffer.alloc(2);
          pcm.writeInt16LE(4096);
          conn.write(`${JSON.stringify({ type: "audio", id, pcm: pcm.toString("base64"), sample_rate: 32000, done: false })}\n`);
          conn.end(); // 首帧刚出就掐：半截音频已在消费方手里
        },
      });
      const fake = makePerCallCapableHost();
      try {
        const synth = createVoxcpmSynth(specOf(labDir), fake.host, FAST);
        const chunks: number[] = [];
        await expect(
          (async () => {
            for await (const chunk of synth(REQUEST)) {
              chunks.push(chunk.samples[0]!);
            }
            return chunks;
          })(),
        ).rejects.toThrow(/不可重放/);
        expect(chunks).toEqual([0.125]); // 首帧确实交付过
        expect(fake.daemons).toHaveLength(0); // 不重放：零 per-call 拉起
      } finally {
        await daemon.close();
      }
    });
  });

  it("daemon 请求超时：kill 后（首帧前）降级 per-call，超时请求不静默失踪", async () => {
    await withTempLab(async (labDir, fp) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: voxcpmReady({ weights_fingerprint: fp }), onLine: "ignore" });
      const fake = makePerCallCapableHost();
      try {
        const synth = createVoxcpmSynth(specOf(labDir), fake.host, { ...FAST, requestTimeoutMs: 120 });
        const out = await collect(synth(REQUEST));
        expect(out.sampleRate).toBe(48000); // 降级重放出声
        expect(fake.daemons).toHaveLength(1);
        expect(fake.daemons[0]!.args).not.toContain("--daemon");
      } finally {
        await daemon.close();
      }
    });
  });

  it("daemon 报 error 帧：EngineError 直报，不经 per-call 重放（同一请求必复现）", async () => {
    await withTempLab(async (labDir, fp) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: voxcpmReady({ weights_fingerprint: fp }), onLine: "error" });
      const fake = makePerCallCapableHost();
      try {
        const synth = createVoxcpmSynth(specOf(labDir), fake.host, FAST);
        await expect(collect(synth(REQUEST))).rejects.toThrow(/参考音频损坏/);
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
        ready: voxcpmReady({ weights_fingerprint: fp }),
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
        const synth = createVoxcpmSynth(specOf(labDir), fake.host, FAST);
        const out1 = await collect(synth(REQUEST));
        expect(out1.sampleRate).toBe(48000); // 首请求队满 → per-call 重放出声
        const out2 = await collect(synth({ ...REQUEST, text: "Second line" }));
        expect(out2.sampleRate).toBe(32000); // 次请求队已腾出 → 仍走常驻，sticky 未误置
        expect(daemon.connects).toBe(1); // 队满不 kill daemon：同一连接延续
      } finally {
        await daemon.close();
      }
    });
  });

  it("版本键不符（旧代码 daemon）：kill 重拉一次后仍不符则降级 per-call", async () => {
    await withTempLab(async (labDir) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: voxcpmReady({ weights_fingerprint: "fp-stale-old-daemon" }) });
      const fake = makePerCallCapableHost();
      try {
        const synth = createVoxcpmSynth(specOf(labDir), fake.host, FAST);
        const out = await collect(synth(REQUEST));
        expect(out.sampleRate).toBe(48000); // 过期 daemon 被拒，per-call 兜底出声
        expect(daemon.connects).toBeGreaterThanOrEqual(1);
      } finally {
        await daemon.close();
      }
    });
  });
});

describe("createVoxcpmEngine 默认接线（daemon-first 生效面）", () => {
  const VOICES = "/data/voices";

  function makeEngine(fake: ReturnType<typeof createFakeHost>, labDir: string): EngineAdapter {
    return createVoxcpmEngine({
      host: fake.host,
      labDir,
      voicesDir: VOICES,
      daemon: FAST, // 收窗计时：真机缺省 180s/180s，测试不能等
    });
  }

  it("不注入 synth：默认走常驻 daemon，default 嗓 voice creation 的 control 描述下传", async () => {
    await withTempLab(async (labDir, fp) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: voxcpmReady({ weights_fingerprint: fp }) });
      const fake = createFakeHost({ env: { HOME: "/h" }, daemonFactory: () => null });
      try {
        const engine = makeEngine(fake, labDir);
        const out = await engine.speak("你好世界", { voice: null, rateWpm: 175, output: null });
        expect(out).toMatchObject({ type: "pcm", sampleRate: 32000 });
        const req = JSON.parse(daemon.requests[0]!) as Record<string, unknown>;
        expect(req.control).toBe("A clear and natural voice, speaking at a calm and steady pace");
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
      const out = await engine.speak("你好世界", { voice: null, rateWpm: 175, output: null });
      expect(out).toMatchObject({ type: "pcm", sampleRate: 48000 });
      expect(fake.daemons[0]!.args).toContain("--daemon"); // 首选形态确实是常驻 daemon
      expect(fake.daemons[1]!.args).not.toContain("--daemon"); // 退路 per-call 兜住出声
    });
  });
});

describe("daemon 熔断（voxcpm 装配面）：daemon-failures 跨调用闸住拉起", () => {
  function circuitPathOf(labDir: string): string {
    return join(labDir, "daemon-failures");
  }

  it("三次连续拉起失败开窗：第四次不再触 daemon，直接 per-call 出声", async () => {
    await withTempLab(async (labDir) => {
      const clock = { t: 5_000_000 };
      const fake = makePerCallCapableHost({ now: () => clock.t });
      for (let i = 0; i < 3; i += 1) {
        const synth = createVoxcpmSynth(specOf(labDir), fake.host, FAST);
        expect((await collect(synth(REQUEST))).sampleRate).toBe(48000); // 每轮都经 per-call 退路出声
      }
      const opened = readCircuitRecord(circuitPathOf(labDir));
      expect(opened?.openedAt).toBe(clock.t); // 第三次失败即开窗（票 04：3 次进冷却）
      const synth4 = createVoxcpmSynth(specOf(labDir), fake.host, FAST);
      expect((await collect(synth4(REQUEST))).sampleRate).toBe(48000); // 冷却期内 daemon 完全不碰
      expect(fake.daemons.filter((d) => d.args.includes("--daemon"))).toHaveLength(3); // 零新拉起
    });
  });

  it("成功温态合成清零计数（删文件）", async () => {
    await withTempLab(async (labDir, fp) => {
      const clock = { t: 5_000_000 };
      writeFileSync(circuitPathOf(labDir), JSON.stringify({ count: 2, lastAt: clock.t, openedAt: null }));
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: voxcpmReady({ weights_fingerprint: fp }) });
      const fake = makePerCallCapableHost({ now: () => clock.t });
      try {
        const synth = createVoxcpmSynth(specOf(labDir), fake.host, FAST);
        expect((await collect(synth(REQUEST))).sampleRate).toBe(32000);
        expect(readCircuitRecord(circuitPathOf(labDir))?.count).toBe(0); // 温态成功抹掉劣化史
      } finally {
        await daemon.close();
        void fake;
      }
    });
  });

  it("冷却到期放行：daemon-first 恢复，成功合成把计数文件写没", async () => {
    await withTempLab(async (labDir, fp) => {
      const clock = { t: 5_000_000 };
      writeFileSync(circuitPathOf(labDir), JSON.stringify({ count: 3, lastAt: clock.t - CIRCUIT_COOLDOWN_MS - 1, openedAt: clock.t - CIRCUIT_COOLDOWN_MS - 1 }));
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: voxcpmReady({ weights_fingerprint: fp }) });
      const fake = makePerCallCapableHost({ now: () => clock.t });
      try {
        const synth = createVoxcpmSynth(specOf(labDir), fake.host, FAST);
        expect((await collect(synth(REQUEST))).sampleRate).toBe(32000); // 到期给一次重试机会且成功
        expect(readCircuitRecord(circuitPathOf(labDir))?.count).toBe(0);
      } finally {
        await daemon.close();
        void fake;
      }
    });
  });
});

describe("SAY_DAEMON 逃生门（voxcpm 装配面）", () => {
  const VOICES = "/data/voices";

  async function speakThrough(fakeHost: ReturnType<typeof createFakeHost>, labDir: string): Promise<{ type: string; sampleRate: number }> {
    const engine = createVoxcpmEngine({ host: fakeHost.host, labDir, voicesDir: VOICES, daemon: FAST });
    return engine.speak("你好世界", { voice: null, rateWpm: 175, output: null }) as Promise<{ type: string; sampleRate: number }>;
  }

  it("off：daemon 面零接触（健康 daemon 在位也不连），直接 per-call，与 daemon 上线前行为同形", async () => {
    await withTempLab(async (labDir, fp) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: voxcpmReady({ weights_fingerprint: fp }) });
      const fake = makePerCallCapableHost({ env: { SAY_DAEMON: "off" } });
      try {
        const out = await speakThrough(fake, labDir);
        expect(out.sampleRate).toBe(48000); // per-call 面出声
        expect(daemon.connects).toBe(0); // 连都不连
        expect(fake.daemons).toHaveLength(1);
        expect(fake.daemons[0]!.args).not.toContain("--daemon");
        expect(existsSync(join(labDir, "daemon-failures"))).toBe(false); // off 不是失败：不进熔断
      } finally {
        await daemon.close();
      }
    });
  });

  it("on 显式值与缺省同义：daemon-first 照常", async () => {
    await withTempLab(async (labDir, fp) => {
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: voxcpmReady({ weights_fingerprint: fp }) });
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
      const daemon = await startFakeDaemon(join(labDir, "daemon.sock"), { ready: voxcpmReady({ weights_fingerprint: fp }) });
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
