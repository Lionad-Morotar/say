import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { EnvMap } from "./types.ts";

/** inherit 用于透传（进度条、交互高亮、`-v ?` 列表都要直达终端）；capture 用于本工具自己的合成调用 */
export type StdioMode = "inherit" | "capture";

export interface SpawnOpts {
  stdin?: string;
  stdio?: StdioMode;
}

/** exitCode 在被信号杀死时为 null，判死看事件本身、判死因看 signal，不能用 code 是否为空 */
export interface SpawnOutcome {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/**
 * 常驻子进程接缝：管道三向常开（协议引擎的 stdin/stdout JSON 行交互），
 * 与一次性收齐的 spawn 不同——调用方按行驱动，进程生死以 exit settle 为准。
 * spawn 本身失败（解释器不存在等）也折进 exit（signal = "SPAWN_ERROR"），
 * 让「等 ready 或等死」两个 await 点统一收敛，不另设错误通道。
 */
export interface DaemonProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** 子进程 pid（诊断与外部信号用）；spawn 本身失败时为 null */
  readonly pid: number | null;
  readonly exit: Promise<{ exitCode: number | null; signal: string | null }>;
}

export interface DaemonSpawnOpts {
  /** 增量 env（合并进父进程 env），协议引擎不需要干净环境但要能注入调试开关 */
  env?: EnvMap;
}

/**
 * 一切触达操作系统的动作都收在这里。编排层只依赖本接口，
 * 单测注入假 host 即可覆盖回退、透传、临时名与退出码语义，不碰真实模型与真实用户目录。
 */
export interface Host {
  env: EnvMap;
  pid: number;
  /** 播放用临时 wav 的落点。进程内引擎只产出裸样本，封容器后需要一个可写目录 */
  tmpDir: string;
  now(): number;
  writeStderr(text: string): void;
  /** 面向用户的标准输出通道（engine ls/use 的清单与确认行）。合成链路不用它，保持 stdout 可管道 */
  writeStdout(text: string): void;
  spawn(cmd: string, args: readonly string[], opts?: SpawnOpts): Promise<SpawnOutcome>;
  /** 常驻子进程（stdin/stdout JSON 行协议面）。返回前进程已拉起，spawn 失败经 exit 的 SPAWN_ERROR 表达 */
  spawnDaemon(cmd: string, args: readonly string[], opts?: DaemonSpawnOpts): DaemonProcess;
  /** 递归建目录（已存在即成功）。config 写入前的落点保障 */
  mkdir(path: string): Promise<void>;
  fileExists(path: string): boolean;
  /** 目录直下条目名（仅目录），失败或不存在返回空：角色音色注册表的枚举通道 */
  listDirEntries(path: string): readonly string[];
  readFileText(path: string): Promise<string>;
  /** 二进制读：参考音频窗口规整等字节级检查用；文本面请走 readFileText */
  readFileBytes(path: string): Promise<Uint8Array>;
  readStdin(): Promise<string>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  removeFile(path: string): Promise<void>;
  renameFile(from: string, to: string): Promise<void>;
}

const SYSTEM_SAY = "/usr/bin/say";

function spawnWith(
  cmd: string,
  args: readonly string[],
  stdio: StdioMode,
  needsStdin: boolean,
): ChildProcessByStdio<Writable, Readable | null, Readable | null> {
  if (stdio === "inherit") {
    return spawn(cmd, [...args], {
      stdio: [needsStdin ? "pipe" : "inherit", "inherit", "inherit"],
    }) as ChildProcessByStdio<Writable, Readable | null, Readable | null>;
  }
  return spawn(cmd, [...args], {
    stdio: [needsStdin ? "pipe" : "ignore", "pipe", "pipe"],
  }) as ChildProcessByStdio<Writable, Readable | null, Readable | null>;
}

/** 采集流内容；inherit 模式下流为 null，返回空串 */
function collect(stream: Readable | null): Promise<string> {
  if (stream === null) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

export function createNodeHost(env: EnvMap = process.env): Host {
  return {
    env,
    pid: process.pid,
    // 从注入的 env 解析而不是直接问 os.tmpdir()：后者读的是 process.env，
    // 测试用注入 env 隔离真实用户目录的约定会被绕过
    tmpDir: env.TMPDIR?.replace(/\/+$/, "") || tmpdir(),
    now: () => Date.now(),
    writeStderr: (text) => {
      process.stderr.write(text);
    },
    writeStdout: (text) => {
      process.stdout.write(text);
    },
    // node 的 recursive mkdir 会返回首个新建目录，接缝面把它抹成 void（调用方不消费该值）
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    spawn: (cmd, args, opts) => {
      const stdio = opts?.stdio ?? "capture";
      const stdin = opts?.stdin;
      const child = spawnWith(cmd, args, stdio, stdin !== undefined);
      const stdout = collect(child.stdout);
      const stderr = collect(child.stderr);
      if (stdin !== undefined && child.stdin !== null) {
        // 写失败（子进程提前退出）不该成为未处理的 stream error，正文结局以退出码为准
        child.stdin.end(stdin, () => undefined);
        child.stdin.on("error", () => undefined);
      }
      return new Promise<SpawnOutcome>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (code, signal) => {
          void Promise.all([stdout, stderr]).then(
            ([out, err]) => resolve({ exitCode: code, signal, stdout: out, stderr: err }),
            () => resolve({ exitCode: code, signal, stdout: "", stderr: "" }),
          );
        });
      });
    },
    spawnDaemon: (cmd, args, opts) => {
      const child = spawn(cmd, [...args], {
        stdio: ["pipe", "pipe", "pipe"],
        env: opts?.env ? { ...process.env, ...opts.env } : process.env,
      }) as ChildProcessByStdio<Writable, Readable, Readable>;
      // 子进程死亡后调用方仍在写 stdin 会触发 EPIPE 并升级成 uncaughtException——
      // 写入死进程本无意义，错误吞掉，结局统一由 exit 表达
      child.stdin.on("error", () => undefined);
      // process handle 的保活引用与 stdio 流各自独立：常驻子进程只凭存活就拖住宿主
      // 事件循环（CLI 合成完永不退出），活性统一交 stdio 流的 ref/unref 管理
      child.unref();
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        pid: child.pid ?? null,
        exit: new Promise((resolve) => {
          child.on("error", () => resolve({ exitCode: null, signal: "SPAWN_ERROR" }));
          child.on("exit", (code, signal) => resolve({ exitCode: code, signal }));
        }),
      };
    },
    fileExists: (p) => existsSync(p),
    listDirEntries: (p) => {
      try {
        return readdirSync(p, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        // 目录不存在或不可读按空处理：注册表为空是合法状态，角色嗓只是没有而已
        return [];
      }
    },
    readFileText: (p) => readFile(p, "utf8"),
    readFileBytes: async (p) => new Uint8Array(await readFile(p)),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    },
    writeFile: (path, data) => writeFile(path, data),
    // 清理是幂等意图：文件已经不在了就算达成目的，不该让收尾把成功的调用变成失败
    removeFile: async (path) => {
      try {
        await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
    renameFile: (from, to) => rename(from, to),
  };
}

export const SYSTEM_SAY_BIN = SYSTEM_SAY;
