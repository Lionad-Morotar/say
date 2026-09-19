import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE } from "../src/config.ts";
import { createDefaultRegistry } from "../src/engines/index.ts";
import { createNodeHost, type Host } from "../src/host.ts";
import { resolvePaths } from "../src/paths.ts";
import { run } from "../src/speak.ts";
import { createFakeHost, type FakeHostOptions } from "./fake-host.ts";

const SAY = "/usr/bin/say";
const CONFIG = "/h/.config/say/config.toml";

function setup(options: FakeHostOptions = {}) {
  const fake = createFakeHost({
    ...options,
    env: { HOME: "/h", ...options.env },
    files: { [SAY]: "", ...options.files },
  });
  const host: Host = fake.host;
  return { ...fake, host, paths: resolvePaths(host.env) };
}

async function invoke(options: FakeHostOptions, argv: readonly string[]) {
  const ctx = setup(options);
  const code = await run(argv, {
    host: ctx.host,
    paths: ctx.paths,
    registry: createDefaultRegistry(ctx.host),
    sayBin: SAY,
  });
  return { code, ...ctx };
}

describe("system 引擎出声闭环", () => {
  it("正文经 stdin 交给系统 say，退出码 0", async () => {
    const { code, spawns } = await invoke({ env: { SAY_ENGINE: "system" } }, ["hello", "there"]);
    expect(code).toBe(0);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.cmd).toBe(SAY);
    expect(spawns[0]?.stdin).toBe("hello there");
    expect(spawns[0]?.args).toContain("-f");
    expect(spawns[0]?.args).not.toContain("-o");
  });

  it("语速以 wpm 原样下传，系统 say 与本工具同单位", async () => {
    const { spawns } = await invoke({ env: { SAY_ENGINE: "system" } }, ["-r", "220", "hi"]);
    const args = spawns[0]?.args ?? [];
    expect(args[args.indexOf("-r") + 1]).toBe("220");
  });

  it("-o 写 PID 临时名再原子改名，容器格式显式声明为 WAVE", async () => {
    const { code, spawns, renames } = await invoke(
      { env: { SAY_ENGINE: "system" }, pid: 4242 },
      ["-o", "/tmp/out.wav", "hi"],
    );
    expect(code).toBe(0);
    const args = spawns[0]?.args ?? [];
    const temp = args[args.indexOf("-o") + 1];
    expect(temp).toBe("/tmp/out.wav.4242.tmp");
    expect(args).toContain("--file-format=WAVE");
    expect(args).toContain("--data-format=LEI16");
    expect(renames).toEqual([{ from: "/tmp/out.wav.4242.tmp", to: "/tmp/out.wav" }]);
  });

  it("改名失败时清掉系统嗓写出的临时文件，不在目标目录留孤儿", async () => {
    const ctx = setup({ env: { SAY_ENGINE: "system" }, pid: 5150 });
    const host: Host = {
      ...ctx.host,
      renameFile: async () => {
        throw new Error("EXDEV: cross-device link");
      },
    };
    const code = await run(["-o", "/tmp/out.wav", "hi"], {
      host,
      paths: ctx.paths,
      registry: createDefaultRegistry(host),
      sayBin: SAY,
    });
    expect(code).toBe(1);
    expect(ctx.removes).toEqual(["/tmp/out.wav.5150.tmp"]);
  });

  it("-v 音色名原样下传", async () => {
    const { spawns } = await invoke({ env: { SAY_ENGINE: "system" } }, ["-v", "Tingting", "hi"]);
    const args = spawns[0]?.args ?? [];
    expect(args[args.indexOf("-v") + 1]).toBe("Tingting");
  });

  it("系统 say 非零退出且无声无产物时本命令非零，stderr 带原因", async () => {
    const { code, stderr } = await invoke(
      { env: { SAY_ENGINE: "system" }, spawnOutcome: () => ({ exitCode: 1, signal: null, stdout: "", stderr: "boom" }) },
      ["hi"],
    );
    expect(code).toBe(1);
    expect(stderr.join("")).toContain("boom");
  });

  it("被信号杀死时退出码为 null，仍按失败处理而非误判成功", async () => {
    const { code } = await invoke(
      { env: { SAY_ENGINE: "system" }, spawnOutcome: () => ({ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "" }) },
      ["hi"],
    );
    expect(code).toBe(1);
  });

  it("/usr/bin/say 不在盘上即引擎不可用", async () => {
    const fake = createFakeHost({ env: { HOME: "/h", SAY_ENGINE: "system" } });
    const code = await run(["hi"], {
      host: fake.host,
      paths: resolvePaths(fake.host.env),
      registry: createDefaultRegistry(fake.host),
      sayBin: SAY,
    });
    expect(code).toBe(1);
    expect(fake.stderr.join("")).toContain(SAY);
  });
});

describe("正文来源优先级", () => {
  it("位置参数覆盖 -f（与 macOS say 实测一致）", async () => {
    const { spawns } = await invoke(
      { env: { SAY_ENGINE: "system" }, files: { "/tmp/n.txt": "file body" } },
      ["-f", "/tmp/n.txt", "positional"],
    );
    expect(spawns[0]?.stdin).toBe("positional");
  });

  it("-f 指向文件时读文件内容", async () => {
    const { spawns } = await invoke(
      { env: { SAY_ENGINE: "system" }, files: { "/tmp/n.txt": "file body" } },
      ["-f", "/tmp/n.txt"],
    );
    expect(spawns[0]?.stdin).toBe("file body");
  });

  it("-f - 与零参数都读 stdin", async () => {
    const a = await invoke({ env: { SAY_ENGINE: "system" }, stdin: "piped\n" }, ["-f", "-"]);
    expect(a.spawns[0]?.stdin).toBe("piped\n");
    const b = await invoke({ env: { SAY_ENGINE: "system" }, stdin: "piped\n" }, []);
    expect(b.spawns[0]?.stdin).toBe("piped\n");
  });

  it("-f 指向不存在的文件是用法层失败，不去合成", async () => {
    const { code, spawns, stderr } = await invoke({ env: { SAY_ENGINE: "system" } }, ["-f", "/tmp/missing.txt"]);
    expect(code).toBe(1);
    expect(spawns).toHaveLength(0);
    expect(stderr.join("")).toContain("/tmp/missing.txt");
  });

  it("正文为空即静默成功，与 macOS say 空串行为对齐", async () => {
    const { code, spawns } = await invoke({ env: { SAY_ENGINE: "system" }, stdin: "   \n" }, []);
    expect(code).toBe(0);
    expect(spawns).toHaveLength(0);
  });
});

describe("配置三层优先级", () => {
  it("config.toml 被读取：零 flag 时文件里的音色生效", async () => {
    const { code, spawns } = await invoke({ env: { SAY_ENGINE: "system" }, files: { [CONFIG]: 'voice = "Eddy"\n' } }, ["hi"]);
    expect(code).toBe(0);
    const args = spawns[0]?.args ?? [];
    expect(args[args.indexOf("-v") + 1]).toBe("Eddy");
  });

  it("默认引擎必在注册表中，零配置调用不会因引擎缺失而失败", () => {
    const ctx = setup();
    expect(createDefaultRegistry(ctx.host).names()).toContain(DEFAULT_ENGINE);
  });

  it("env 覆盖 config", async () => {
    const { spawns } = await invoke(
      { env: { SAY_ENGINE: "system", SAY_VOICE: "Eddy" }, files: { [CONFIG]: 'engine = "nope"\nvoice = "X"\n' } },
      ["hi"],
    );
    const args = spawns[0]?.args ?? [];
    expect(args[args.indexOf("-v") + 1]).toBe("Eddy");
  });

  it("flag 覆盖 env", async () => {
    const { spawns } = await invoke(
      { env: { SAY_ENGINE: "system", SAY_VOICE: "Eddy" } },
      ["-v", "Flo", "hi"],
    );
    const args = spawns[0]?.args ?? [];
    expect(args[args.indexOf("-v") + 1]).toBe("Flo");
  });

  it("config 语法损坏时降级为默认值并给出警告，不让命令瘫痪", async () => {
    const { code, stderr, spawns } = await invoke({ env: { SAY_ENGINE: "system" }, files: { [CONFIG]: 'engine = "system' } }, ["hi"]);
    expect(stderr.join("")).toContain(CONFIG);
    expect(code).toBe(0);
    expect(spawns).toHaveLength(1);
  });

  it("环境层坏值降级并警告", async () => {
    const { spawns, stderr } = await invoke(
      { env: { SAY_ENGINE: "system", SAY_SPEED: "fast" } },
      ["hi"],
    );
    expect(stderr.join("")).toContain("SAY_SPEED");
    const args = spawns[0]?.args ?? [];
    expect(args[args.indexOf("-r") + 1]).toBe("175");
  });

  it("配置文件不存在时全默认值可用，不产生警告", async () => {
    const { stderr } = await invoke({ env: { SAY_ENGINE: "system" } }, ["hi"]);
    expect(stderr.join("")).toBe("");
  });
});

describe("未支持 flag 整条透传", () => {
  it("原始 argv 原样交给系统 say 并继承退出码", async () => {
    const { code, spawns } = await invoke({}, ["--progress", "-o", "/tmp/x.aiff", "passthrough"]);
    expect(code).toBe(0);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.cmd).toBe(SAY);
    expect(spawns[0]?.args).toEqual(["--progress", "-o", "/tmp/x.aiff", "passthrough"]);
  });

  it("透传用 inherit 让进度条与交互高亮直达终端", async () => {
    const ctx = setup({});
    let seen: string | undefined;
    const host: Host = {
      ...ctx.host,
      spawn: async (cmd, args, opts) => {
        seen = opts?.stdio;
        return ctx.host.spawn(cmd, args, opts);
      },
    };
    await run(["--progress", "hi"], {
      host,
      paths: ctx.paths,
      registry: createDefaultRegistry(host),
      sayBin: SAY,
    });
    expect(seen).toBe("inherit");
  });

  it("透传路径的退出码原样返回，不做归一化", async () => {
    const { code } = await invoke(
      { spawnOutcome: () => ({ exitCode: 3, signal: null, stdout: "", stderr: "say: oops" }) },
      ["-a", "1", "hi"],
    );
    expect(code).toBe(3);
  });

  it("透传不注入本工具的 WAVE 格式 flag，产物容器由系统 say 决定", async () => {
    const { spawns } = await invoke({}, ["--progress", "-o", "/tmp/x.aiff", "hi"]);
    expect(spawns[0]?.args).not.toContain("--file-format=WAVE");
  });

  it("`-v ?` 的音色列表经 inherit 直达终端，不被合成通道吞掉", async () => {
    const ctx = setup({});
    const seen: Array<{ args: string[]; stdio: string | undefined }> = [];
    const host: Host = {
      ...ctx.host,
      spawn: async (_cmd, args, opts) => {
        seen.push({ args: [...args], stdio: opts?.stdio });
        return { exitCode: 0, signal: null, stdout: "Albert    en_US    # hi\n", stderr: "" };
      },
    };
    const code = await run(["-v", "?"], {
      host,
      paths: ctx.paths,
      registry: createDefaultRegistry(host),
      sayBin: SAY,
    });
    expect(code).toBe(0);
    expect(seen).toEqual([{ args: ["-v", "?"], stdio: "inherit" }]);
  });

  it("透传时不读配置文件，config 里的 engine 不影响转交", async () => {
    const { spawns } = await invoke({ files: { [CONFIG]: 'engine = "sherpa"\n' } }, ["-i", "hi"]);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.cmd).toBe(SAY);
  });
});

describe("用法错误", () => {
  it("受支持 flag 缺值退出码 2 且不合成", async () => {
    const { code, spawns, stderr } = await invoke({}, ["-v"]);
    expect(code).toBe(2);
    expect(spawns).toHaveLength(0);
    expect(stderr.join("")).toContain("-v");
  });

  it("语速非数值退出码 2", async () => {
    const { code } = await invoke({}, ["-r", "abc", "hi"]);
    expect(code).toBe(2);
  });
});

describe("真实 host 与假 host 的接口一致性", () => {
  it("createNodeHost 满足 Host 契约（只校验形状，不触发真实子进程）", () => {
    const host = createNodeHost({ HOME: "/h" });
    expect(host.pid).toBe(process.pid);
    expect(typeof host.now()).toBe("number");
    expect(host.fileExists(SAY)).toBe(true);
  });
});
