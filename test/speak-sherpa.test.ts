import { describe, expect, it } from "vitest";
import { createRegistry, createSherpaEngine, createSystemEngine } from "../src/engines/index.ts";
import type { SherpaSynth, SherpaSynthRequest } from "../src/engines/sherpa.ts";
import { AFPLAY_BIN } from "../src/player.ts";
import { resolvePaths } from "../src/paths.ts";
import { run } from "../src/speak.ts";
import { createFakeHost, type FakeHostOptions } from "./fake-host.ts";

const SAY = "/usr/bin/say";
const TMP = "/var/tmp";
const MODELS = "/cache/models";
const KOKORO = `${MODELS}/sherpa/kokoro-multi-lang-v1_1`;

const MATCHA = `${MODELS}/sherpa/matcha-icefall-zh-baker`;
const VOCODER = `${MODELS}/sherpa/vocoders/vocos-22khz-univ.onnx`;

/** 只装 matcha 的环境：kokoro 缺席时点名 matcha 音色仍应走进程内推理，而不是被 kokoro 缺失连坐 */
const MATCHA_ONLY_FILES: Record<string, string> = {
  [SAY]: "",
  [`${MATCHA}/model-steps-3.onnx`]: "",
  [`${MATCHA}/lexicon.txt`]: "",
  [`${MATCHA}/tokens.txt`]: "",
  [`${MATCHA}/date.fst`]: "",
  [`${MATCHA}/number.fst`]: "",
  [`${MATCHA}/phone.fst`]: "",
  [VOCODER]: "",
};

const KOKORO_FILES: Record<string, string> = {
  [SAY]: "",
  [`${KOKORO}/model.onnx`]: "",
  [`${KOKORO}/voices.bin`]: "",
  [`${KOKORO}/tokens.txt`]: "",
  [`${KOKORO}/espeak-ng-data`]: "",
  [`${KOKORO}/lexicon-us-en.txt`]: "",
  [`${KOKORO}/lexicon-zh.txt`]: "",
  [`${KOKORO}/date-zh.fst`]: "",
  [`${KOKORO}/number-zh.fst`]: "",
};

/** 有能量的样本：全零或全 NaN 会被适配器的出声校验判死，测不到交付链路 */
const SAMPLES = new Float32Array([0.2, -0.3, 0.4, -0.1]);

function fakeSynth() {
  const calls: SherpaSynthRequest[] = [];
  const synth: SherpaSynth = async (request) => {
    calls.push(request);
    return { samples: SAMPLES, sampleRate: 24000, numSpeakers: request.spec.kind === "kokoro" ? 103 : 1 };
  };
  return { synth, calls };
}

async function invoke(options: FakeHostOptions, argv: readonly string[], synth: SherpaSynth = fakeSynth().synth) {
  // files 是整体替换而不是叠加：缺资产的用例必须能把默认那套模型文件真的抹掉
  // 钉住 sherpa：裸调在 v2 新语义下落 locale 预设引擎，不再是 sherpa 巧合默认
  const fake = createFakeHost({
    tmpDir: TMP,
    ...options,
    env: { HOME: "/h", SAY_ENGINE: "sherpa", ...options.env },
    files: options.files ?? KOKORO_FILES,
  });
  const code = await run(argv, {
    host: fake.host,
    paths: resolvePaths(fake.host.env),
    registry: createRegistry([
      createSherpaEngine({ host: fake.host, modelsDir: MODELS, synth }),
      createSystemEngine(fake.host, SAY),
    ]),
    sayBin: SAY,
  });
  return { code, ...fake, text: () => fake.stderr.join("") };
}

function riffOf(bytes: Uint8Array): string {
  return String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
}

describe("进程内引擎的 pcm 交付：-o 落盘", () => {
  it("封成 wav 写入 PID 临时名再原子改名到目标", async () => {
    const { code, writes, renames } = await invoke({ pid: 4242 }, ["-o", "/out/a.wav", "hi"]);
    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe("/out/a.wav.4242.tmp");
    expect(renames).toEqual([{ from: "/out/a.wav.4242.tmp", to: "/out/a.wav" }]);
  });

  it("写出的字节是合法 RIFF/WAVE 容器，长度与样本数自洽", async () => {
    const { writes } = await invoke({}, ["-o", "/out/a.wav", "hi"]);
    const bytes = writes[0]!.bytes;
    expect(riffOf(bytes)).toBe("RIFF");
    expect(String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!)).toBe("WAVE");
    expect(bytes.byteLength).toBe(44 + SAMPLES.length * 2);
  });

  it("-o 路径下不出声：afplay 不该被调起", async () => {
    const { spawns } = await invoke({}, ["-o", "/out/a.wav", "hi"]);
    expect(spawns.map((spawn) => spawn.cmd)).not.toContain(AFPLAY_BIN);
  });

  it("不同 PID 的并发调用各写各的临时名，互不覆盖", async () => {
    const a = await invoke({ pid: 111 }, ["-o", "/out/a.wav", "hi"]);
    const b = await invoke({ pid: 222 }, ["-o", "/out/a.wav", "hi"]);
    expect(a.writes[0]?.path).toBe("/out/a.wav.111.tmp");
    expect(b.writes[0]?.path).toBe("/out/a.wav.222.tmp");
    expect(a.renames[0]?.to).toBe(b.renames[0]?.to);
  });
});

describe("进程内引擎的 pcm 交付：默认出声卡", () => {
  it("写暂存 wav、交给 afplay、播完删掉", async () => {
    const { code, writes, spawns, removes } = await invoke({ pid: 4242 }, ["hi"]);
    expect(code).toBe(0);
    expect(writes[0]?.path).toBe(`${TMP}/say-4242.wav`);
    expect(spawns).toEqual([{ cmd: AFPLAY_BIN, args: [`${TMP}/say-4242.wav`], stdin: undefined }]);
    expect(removes).toEqual([`${TMP}/say-4242.wav`]);
  });

  it("暂存名带 PID，并发调用不会互相截断正在播的文件", async () => {
    const a = await invoke({ pid: 111 }, ["hi"]);
    const b = await invoke({ pid: 222 }, ["hi"]);
    expect(a.writes[0]?.path).toBe(`${TMP}/say-111.wav`);
    expect(b.writes[0]?.path).toBe(`${TMP}/say-222.wav`);
  });

  it("afplay 失败即整体失败并给出原因，暂存文件仍然清理", async () => {
    const { code, stderr, removes } = await invoke(
      { spawnOutcome: (record) => (record.cmd === AFPLAY_BIN ? { exitCode: 1, signal: null, stdout: "", stderr: "AudioFileOpen failed" } : { exitCode: 0, signal: null, stdout: "", stderr: "" }) },
      ["hi"],
    );
    expect(code).toBe(1);
    expect(stderr.join("")).toContain("AudioFileOpen failed");
    expect(removes).toEqual([`${TMP}/say-4242.wav`]);
  });

  it("目标目录不可写时按失败处理，不留半截产物冒充成功", async () => {
    const fake = createFakeHost({ tmpDir: TMP, env: { HOME: "/h", SAY_ENGINE: "sherpa" }, files: KOKORO_FILES });
    const host = {
      ...fake.host,
      writeFile: async () => {
        throw new Error("EROFS: read-only file system");
      },
    };
    const code = await run(["-o", "/out/a.wav", "hi"], {
      host,
      paths: resolvePaths(host.env),
      registry: createRegistry([
        createSherpaEngine({ host, modelsDir: MODELS, synth: fakeSynth().synth }),
        createSystemEngine(host, SAY),
      ]),
      sayBin: SAY,
    });
    expect(code).toBe(1);
    expect(fake.stderr.join("")).toContain("EROFS");
    expect(fake.renames).toHaveLength(0);
  });
});

describe("落盘失败的收尾", () => {
  it("改名失败时清掉 PID 临时文件，不在目标目录留孤儿", async () => {
    const fake = createFakeHost({ tmpDir: TMP, pid: 99, env: { HOME: "/h", SAY_ENGINE: "sherpa" }, files: KOKORO_FILES });
    const host = {
      ...fake.host,
      renameFile: async () => {
        throw new Error("EXDEV: cross-device link");
      },
    };
    const code = await run(["-o", "/out/a.wav", "hi"], {
      host,
      paths: resolvePaths(host.env),
      registry: createRegistry([
        createSherpaEngine({ host, modelsDir: MODELS, synth: fakeSynth().synth }),
        createSystemEngine(host, SAY),
      ]),
      sayBin: SAY,
    });
    expect(code).toBe(1);
    expect(fake.writes.map((write) => write.path)).toEqual(["/out/a.wav.99.tmp"]);
    expect(fake.removes).toEqual(["/out/a.wav.99.tmp"]);
    expect(fake.stderr.join("")).toContain("EXDEV");
  });

  it("写盘失败时不去改名，但把可能存在的半截临时文件清掉", async () => {
    const fake = createFakeHost({ tmpDir: TMP, pid: 99, env: { HOME: "/h", SAY_ENGINE: "sherpa" }, files: KOKORO_FILES });
    const host = {
      ...fake.host,
      writeFile: async () => {
        throw new Error("ENOSPC: no space left on device");
      },
    };
    const code = await run(["-o", "/out/a.wav", "hi"], {
      host,
      paths: resolvePaths(host.env),
      registry: createRegistry([
        createSherpaEngine({ host, modelsDir: MODELS, synth: fakeSynth().synth }),
        createSystemEngine(host, SAY),
      ]),
      sayBin: SAY,
    });
    expect(code).toBe(1);
    expect(fake.renames).toHaveLength(0);
    // writeFile 是 O_CREAT|O_TRUNC 先建文件再写，ENOSPC 抛在写入阶段时半截临时文件已经落盘；
    // 清理本身幂等（文件真不在时 ENOENT 被吞），所以写失败也恒清一次，不留孤儿
    expect(fake.removes).toEqual(["/out/a.wav.99.tmp"]);
  });
});

describe("音色名到引擎的路由在真实调用链上生效", () => {
  it("默认引擎是 sherpa，kokoro 音色名映射到表内 sid", async () => {
    const { synth, calls } = fakeSynth();
    const { code } = await invoke({}, ["-v", "zf_001", "hi"], synth);
    expect(code).toBe(0);
    expect(calls[0]).toMatchObject({ sid: 3, speed: 1 });
  });

  it("wpm 经换算下传，用户面语速单位与系统嗓一致", async () => {
    const { synth, calls } = fakeSynth();
    await invoke({}, ["-r", "350", "hi"], synth);
    expect(calls[0]?.speed).toBe(2);
  });

  it("非 sherpa 音色名按系统嗓清单委派，用户写 -v Tingting 拿到的就是那个嗓子", async () => {
    const { synth, calls } = fakeSynth();
    const { code, spawns } = await invoke(
      {
        // 系统嗓开放集的枚举通道：`say -v ?` 的 stdout 形态（名字 + locale + 样例）
        spawnOutcome: () => ({
          exitCode: 0,
          signal: null,
          stdout: "Tingting            zh_CN    # 你好\nAlbert              en_US    # Hello\n",
          stderr: "",
        }),
      },
      ["-v", "Tingting", "hi"],
      synth,
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    // 第一条 spawn 是 `say -v ?` 的清单枚举，第二条才是真正带正文的合成
    const delivery = spawns[spawns.length - 1];
    expect(delivery?.cmd).toBe(SAY);
    const args = delivery?.args ?? [];
    expect(args[args.indexOf("-v") + 1]).toBe("Tingting");
  });

  it("只装 matcha 时点名 zh_baker 仍走进程内推理，不被 kokoro 缺失连坐", async () => {
    const { synth, calls } = fakeSynth();
    const { code, spawns, text } = await invoke(
      { files: MATCHA_ONLY_FILES },
      ["-v", "zh_baker", "-o", "/out/m.wav", "你好"],
      synth,
    );
    expect(code).toBe(0);
    expect(calls[0]?.spec).toMatchObject({ kind: "matcha" });
    expect(spawns).toHaveLength(0);
    expect(text()).toBe("");
  });

  it("只装 matcha 时用默认嗓回退到系统嗓，原因指向真正缺失的 kokoro 资产", async () => {
    const { code, spawns, text } = await invoke({ files: MATCHA_ONLY_FILES }, ["-o", "/out/m.wav", "你好"]);
    expect(code).toBe(0);
    expect(spawns[0]?.cmd).toBe(SAY);
    expect(text()).toContain("say: fallback:");
    expect(text()).toContain("kokoro-multi-lang-v1_1");
  });

  it("显式 engine = system 时引擎优先，sherpa 音色名原样交给系统嗓", async () => {
    const { synth, calls } = fakeSynth();
    const { spawns } = await invoke({ env: { SAY_ENGINE: "system" } }, ["-v", "af_maple", "hi"], synth);
    expect(calls).toHaveLength(0);
    const args = spawns[0]?.args ?? [];
    expect(args[args.indexOf("-v") + 1]).toBe("af_maple");
  });
});

describe("sherpa 资产缺失", () => {
  it("盘上只有 int8 权重时判不可用，改走系统嗓而不是拿它合成静音", async () => {
    const int8Only = Object.fromEntries(
      Object.keys(KOKORO_FILES).map((file) => [
        file === `${KOKORO}/model.onnx` ? `${KOKORO}/model.int8.onnx` : file,
        "",
      ]),
    );
    const { code, spawns, text } = await invoke({ files: int8Only }, ["-o", "/out/a.wav", "hi"]);
    expect(code).toBe(0);
    expect(spawns[0]?.cmd).toBe(SAY);
    expect(text()).toContain("model.onnx");
  });
});
