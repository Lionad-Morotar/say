import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
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
  spawn(cmd: string, args: readonly string[], opts?: SpawnOpts): Promise<SpawnOutcome>;
  fileExists(path: string): boolean;
  /** 目录直下条目名（仅目录），失败或不存在返回空：角色音色注册表的枚举通道 */
  listDirEntries(path: string): readonly string[];
  readFileText(path: string): Promise<string>;
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
