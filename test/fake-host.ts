import type { DaemonProcess, DaemonSpawnOpts, Host, SpawnOpts, SpawnOutcome } from "../src/host.ts";
import type { EnvMap } from "../src/types.ts";
import { PassThrough } from "node:stream";

export interface SpawnRecord {
  cmd: string;
  args: string[];
  stdin: string | undefined;
}

/** 假常驻进程的控制面：测试驱动「子进程行为」，adapter 只见 DaemonProcess 侧 */
export interface FakeDaemonHandle {
  /** 模拟子进程 stdout：测试写 shim 响应行（writer.write('...\n')） */
  output: PassThrough;
  /** 模拟子进程 stderr */
  errors: PassThrough;
  /** 子进程收到过的 stdin 行（末尾换行已剥离），协议请求断言用 */
  readonly requests: string[];
  /** 模拟进程死亡：流收尾 + exit settle，此后写入 stdin 被静默丢弃（对齐真进程 EPIPE 语义） */
  die(signal?: string | null, exitCode?: number | null): void;
}

export interface DaemonSpawnRecord {
  cmd: string;
  args: string[];
  /** spawn 时的增量 env（真 host 合并进父进程 env）；未传时为 undefined */
  env?: EnvMap;
}

/** 工厂按 spawn 参数提供的流；缺省项由 fake 自建，null = spawn 本身失败 */
export interface FakeDaemonWiring {
  output?: PassThrough;
  errors?: PassThrough;
  /** 每收到一行 stdin 请求回调（模拟 shim 读到请求即回写），handle 为本 daemon 控制柄 */
  onRequest?: (line: string, handle: FakeDaemonHandle) => void;
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
  /**
   * 假常驻进程工厂：按 spawn 参数提供子进程的输出流（默认产出可手动驱动的空壳）。
   * 返回 null 模拟 spawn 本身失败（exit 以 SPAWN_ERROR 收场）。
   */
  daemonFactory?: (record: DaemonSpawnRecord) => FakeDaemonWiring | null;
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
  const daemons: DaemonSpawnRecord[] = [];
  const daemonHandles: FakeDaemonHandle[] = [];
  const stderr: string[] = [];
  const stdout: string[] = [];
  const mkdirs: string[] = [];
  const defaultExit = options.exitCode ?? 0;

  const host: Host = {
    env: options.env ?? {},
    pid: options.pid ?? 4242,
    tmpDir: options.tmpDir ?? "/tmp",
    now: options.now ?? (() => 0),
    writeStderr: (text) => {
      stderr.push(text);
    },
    writeStdout: (text) => {
      stdout.push(text);
    },
    mkdir: async (path) => {
      mkdirs.push(path);
    },
    spawn: async (cmd: string, args: readonly string[], spawnOpts?: SpawnOpts) => {
      const record: SpawnRecord = { cmd, args: [...args], stdin: spawnOpts?.stdin };
      spawns.push(record);
      return options.spawnOutcome ? options.spawnOutcome(record) : { exitCode: defaultExit, signal: null, stdout: "", stderr: "" };
    },
    spawnDaemon: (cmd: string, args: readonly string[], opts?: DaemonSpawnOpts): DaemonProcess => {
      const record: DaemonSpawnRecord = { cmd, args: [...args] };
      if (opts?.env !== undefined) record.env = opts.env;
      daemons.push(record);
      const wiring = options.daemonFactory?.(record);
      const requests: string[] = [];
      const alive = wiring !== null;
      let settle: (outcome: { exitCode: number | null; signal: string | null }) => void = () => undefined;
      const exit = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
        settle = resolve;
      });
      const output = wiring?.output ?? new PassThrough();
      const errors = wiring?.errors ?? new PassThrough();
      const handle: FakeDaemonHandle = {
        output,
        errors,
        requests,
        die: (signal = "SIGKILL", exitCode = null) => {
          if (!alive) return;
          output.end();
          errors.end();
          settle({ exitCode, signal });
        },
      };
      const stdin = new PassThrough();
      let buffer = "";
      stdin.on("data", (chunk: Buffer) => {
        if (!alive) return; // 死进程的写入静默丢弃：对齐真管道 EPIPE 被吞后的语义
        buffer += chunk.toString("utf8");
        let cut = buffer.indexOf("\n");
        while (cut >= 0) {
          const line = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 1);
          requests.push(line);
          wiring?.onRequest?.(line, handle);
          cut = buffer.indexOf("\n");
        }
      });
      stdin.on("error", () => undefined);
      if (wiring === null) {
        settle({ exitCode: null, signal: "SPAWN_ERROR" });
      } else {
        daemonHandles.push(handle);
      }
      return { stdin, stdout: output, stderr: errors, pid: alive ? 424242 : null, exit };
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

  return { host, spawns, daemons, daemonHandles, stderr, stdout, mkdirs, renames, writes, removes, files };
}
