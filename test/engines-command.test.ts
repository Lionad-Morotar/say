import { describe, expect, it } from "vitest";
import type { SpawnOutcome } from "../src/host.ts";
import { runEngineCommand } from "../src/engines-command.ts";
import { createDefaultRegistry } from "../src/engines/index.ts";
import { EXIT_FAILURE, EXIT_USAGE } from "../src/report.ts";
import { resolvePaths } from "../src/paths.ts";
import type { RunDeps } from "../src/deps.ts";
import { createFakeHost, type FakeHostOptions, type SpawnRecord } from "./fake-host.ts";

const SAY = "/usr/bin/say";
const CONFIG = "/h/.config/say/config.toml";
const NODE_BIN = process.execPath;

/** install-engine status --json 的产物形态（S1 契约），gptsovits 已装、voxcpm 未装 */
const LAB_JSON = JSON.stringify({
  labRoot: "/h/.local/share/say-lab",
  engines: [
    { engine: "gptsovits", status: "ready", venv: "ok", missing: [], autoPending: [], patchStatus: null },
    {
      engine: "voxcpm",
      status: "missing",
      venv: "missing",
      missing: ["models/model.safetensors"],
      autoPending: [],
      patchStatus: null,
    },
  ],
});

/** defaults 探测不被本模块触发；node 子进程喂 lab JSON，其余（对 /usr/bin/say 的探测）按成功 */
function labOutcome(record: SpawnRecord): SpawnOutcome {
  if (record.cmd === NODE_BIN) return { exitCode: 0, signal: null, stdout: LAB_JSON, stderr: "" };
  return { exitCode: 0, signal: null, stdout: "", stderr: "" };
}

function setup(options: FakeHostOptions = {}) {
  const fake = createFakeHost({
    ...options,
    env: { HOME: "/h", ...options.env },
    files: { [SAY]: "", ...options.files },
    spawnOutcome: options.spawnOutcome ?? labOutcome,
  });
  const deps: RunDeps = {
    host: fake.host,
    paths: resolvePaths(fake.host.env),
    registry: createDefaultRegistry(fake.host),
    sayBin: SAY,
  };
  return { ...fake, deps };
}

function stdoutOf(fake: ReturnType<typeof setup>): string {
  return fake.stdout.join("");
}

function writtenContent(fake: ReturnType<typeof setup>): string {
  const write = fake.writes.find((w) => w.path.startsWith(CONFIG));
  if (write === undefined) throw new Error("config 没有写盘记录");
  return new TextDecoder().decode(write.bytes);
}

describe("engine ls：已接线引擎与 say-lab 安装状态", () => {
  it("列出三个内置引擎与 lab 引擎及安装状态", async () => {
    const fake = setup();
    const code = await runEngineCommand(fake.deps, { kind: "engine", action: "ls", name: null });
    expect(code).toBe(0);
    const out = stdoutOf(fake);
    expect(out).toContain("sherpa");
    expect(out).toContain("zipvoice");
    expect(out).toContain("system");
    expect(out).toContain("gptsovits");
    expect(out).toMatch(/gptsovits\s+lab:ready/);
    expect(out).toMatch(/voxcpm\s+lab:missing/);
    expect(out).not.toMatch(/gptsovits\s+.*wired/);
  });

  it("config 声明的当前引擎标 *，未声明时标默认 sherpa", async () => {
    const marked = setup({ files: { [CONFIG]: 'engine = "system"\n' } });
    await runEngineCommand(marked.deps, { kind: "engine", action: "ls", name: null });
    expect(stdoutOf(marked)).toMatch(/^\* system/m);

    const unmarked = setup();
    await runEngineCommand(unmarked.deps, { kind: "engine", action: "ls", name: null });
    expect(stdoutOf(unmarked)).toMatch(/^\* sherpa/m);
  });

  it("安装状态查询失败时降级只列已接线引擎，stderr 一行说明", async () => {
    const fake = setup({
      spawnOutcome: (record) =>
        record.cmd === NODE_BIN
          ? { exitCode: 1, signal: null, stdout: "", stderr: "boom" }
          : { exitCode: 0, signal: null, stdout: "", stderr: "" },
    });
    const code = await runEngineCommand(fake.deps, { kind: "engine", action: "ls", name: null });
    expect(code).toBe(0);
    const out = stdoutOf(fake);
    expect(out).toContain("sherpa");
    expect(out).not.toContain("gptsovits");
    expect(fake.stderr.join("")).toContain("安装状态查询失败");
  });
});

describe("engine use：行级手术写 config 默认引擎", () => {
  it("无 config 时新建，写入走临时名加原子改名，stdout 确认", async () => {
    const fake = setup();
    const code = await runEngineCommand(fake.deps, { kind: "engine", action: "use", name: "gptsovits" });
    expect(code).toBe(0);
    expect(writtenContent(fake)).toBe('engine = "gptsovits"\n');
    expect(fake.renames).toEqual([{ from: `${CONFIG}.${fake.host.pid}.tmp`, to: CONFIG }]);
    expect(fake.mkdirs).toContain("/h/.config/say");
    expect(stdoutOf(fake)).toContain("默认引擎已设为 gptsovits");
  });

  it("替换既有顶层 engine 行，其余内容（注释与其他键）逐字保留", async () => {
    const fake = setup({
      files: { [CONFIG]: '# 我的配置\nengine = "system"   # 行尾注释会丢\nvoice = "af_sol"\n' },
    });
    const code = await runEngineCommand(fake.deps, { kind: "engine", action: "use", name: "zipvoice" });
    expect(code).toBe(0);
    expect(writtenContent(fake)).toBe('# 我的配置\nengine = "zipvoice"\nvoice = "af_sol"\n');
  });

  it("分节后的同名键属于子表不动，顶层键插入文件头部", async () => {
    const fake = setup({ files: { [CONFIG]: '[presets.calm]\nengine = "zipvoice"\nvoice = "bf_vale"\n' } });
    const code = await runEngineCommand(fake.deps, { kind: "engine", action: "use", name: "gptsovits" });
    expect(code).toBe(0);
    expect(writtenContent(fake)).toBe(
      'engine = "gptsovits"\n[presets.calm]\nengine = "zipvoice"\nvoice = "bf_vale"\n',
    );
  });

  it("未知引擎名拒写并退出用法错误，stderr 列可用清单", async () => {
    const fake = setup();
    const code = await runEngineCommand(fake.deps, { kind: "engine", action: "use", name: "nosuch" });
    expect(code).toBe(EXIT_USAGE);
    expect(fake.writes).toHaveLength(0);
    expect(fake.stderr.join("")).toContain("未知的引擎");
    expect(fake.stderr.join("")).toContain("gptsovits");
  });

  it("未接线但已登记的 lab 引擎可写，stderr 提示回退链", async () => {
    const fake = setup();
    const code = await runEngineCommand(fake.deps, { kind: "engine", action: "use", name: "gptsovits" });
    expect(code).toBe(0);
    expect(fake.stderr.join("")).toContain("尚未接线");
  });

  it("config 语法损坏拒写退出失败，损坏原因先于覆盖可见", async () => {
    const fake = setup({ files: { [CONFIG]: 'engine = "broken\n' } });
    const code = await runEngineCommand(fake.deps, { kind: "engine", action: "use", name: "system" });
    expect(code).toBe(EXIT_FAILURE);
    expect(fake.renames).toHaveLength(0);
    expect(fake.stderr.join("")).toContain("拒绝写入");
  });
});
