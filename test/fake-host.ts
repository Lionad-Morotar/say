import type { Host, SpawnOpts, SpawnOutcome } from "../src/host.ts";
import type { EnvMap } from "../src/types.ts";

export interface SpawnRecord {
  cmd: string;
  args: string[];
  stdin: string | undefined;
}

export interface FakeHostOptions {
  env?: EnvMap;
  pid?: number;
  tmpDir?: string;
  /** 存在的文件路径 → 内容；未列出的路径视为不存在 */
  files?: Record<string, string>;
  stdin?: string;
  /** 按命令与参数决定子进程结局；未匹配时按 exitCode 默认值 */
  spawnOutcome?: (record: SpawnRecord) => SpawnOutcome;
  exitCode?: number;
  /** 注入时钟。默认恒 0 会让耗时字段全是零，测不出摘要行是否真的在计时 */
  now?: () => number;
}

/**
 * 编排层的测试接缝：所有触达操作系统的动作都收在 Host 上，
 * 单测因此不需要 vi.mock（模块级 mock 拦不到被测模块内部的静态 import），
 * 也不需要真实模型、真实 /usr/bin/say 与真实用户配置目录。
 */
export function createFakeHost(options: FakeHostOptions = {}) {
  const files = new Map(Object.entries(options.files ?? {}));
  const renames: Array<{ from: string; to: string }> = [];
  const writes: Array<{ path: string; bytes: Uint8Array }> = [];
  const removes: string[] = [];
  const spawns: SpawnRecord[] = [];
  const stderr: string[] = [];
  const defaultExit = options.exitCode ?? 0;

  const host: Host = {
    env: options.env ?? {},
    pid: options.pid ?? 4242,
    tmpDir: options.tmpDir ?? "/tmp",
    now: options.now ?? (() => 0),
    writeStderr: (text) => {
      stderr.push(text);
    },
    spawn: async (cmd: string, args: readonly string[], spawnOpts?: SpawnOpts) => {
      const record: SpawnRecord = { cmd, args: [...args], stdin: spawnOpts?.stdin };
      spawns.push(record);
      return options.spawnOutcome ? options.spawnOutcome(record) : { exitCode: defaultExit, signal: null, stdout: "", stderr: "" };
    },
    fileExists: (p) => files.has(p),
    listDirEntries: (p) => {
      // files 表是平的：以 `<dir>/x/` 前缀出现过即视为 dir 下有子目录 x（仅目录条目）
      const prefix = p.endsWith("/") ? p : `${p}/`;
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const cut = rest.indexOf("/");
        if (cut > 0) names.add(rest.slice(0, cut));
      }
      return [...names];
    },
    readFileText: async (p) => {
      const content = files.get(p);
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
    readStdin: async () => options.stdin ?? "",
    writeFile: async (path, data) => {
      writes.push({ path, bytes: data });
      files.set(path, "");
    },
    removeFile: async (path) => {
      removes.push(path);
      files.delete(path);
    },
    renameFile: async (from, to) => {
      renames.push({ from, to });
      files.set(to, files.get(from) ?? "");
      files.delete(from);
    },
  };

  return { host, spawns, stderr, renames, writes, removes, files };
}
