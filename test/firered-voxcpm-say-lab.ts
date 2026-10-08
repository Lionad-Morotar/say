/**
 * firered 与 voxcpm 真机安装面的收集期探活与 daemon 直驱原语（S5 验收套件共享）。
 *
 * 门控纪律沿用 indextts-say-lab 先例：探活在收集期、判据是「能力在场」而非 env 存在——
 * venv 解释器可 import 引擎依赖、权重文件级在场、参考资产在场分层探测，
 * 缺任一层对应套件 skip 而非 fail，无引擎机器上全量照绿。
 * 必须走 userInfo().homedir：vitest 注入 HOME=/nonexistent-say-test-home（接缝隔离）。
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";

export const FIRERED_SHIM = fileURLToPath(new URL("../scripts/shims/firered-shim.py", import.meta.url));
export const VOXCPM_SHIM = fileURLToPath(new URL("../scripts/shims/voxcpm-shim.py", import.meta.url));

export const FIRERED_LAB = process.env.SAY_LAB_DIR ? join(process.env.SAY_LAB_DIR, "firered") : join(userInfo().homedir, ".local/share/say-lab", "firered");
export const VOXCPM_LAB = process.env.SAY_LAB_DIR ? join(process.env.SAY_LAB_DIR, "voxcpm") : join(userInfo().homedir, ".local/share/say-lab", "voxcpm");

/** venv 解释器三形态探测（与 src/engines/voxcpm.ts resolveLabPython 同序判据），附加可 import 校验 */
function resolveVenv(labDir: string, probeModule: string, timeoutMs: number): string | null {
  for (const rel of ["venv/bin/python", ".venv/bin/python"]) {
    const p = join(labDir, rel);
    if (!existsSync(p)) continue;
    try {
      execFileSync(p, ["-c", `import ${probeModule}`], { timeout: timeoutMs, stdio: "pipe" });
      return p;
    } catch {
      return null;
    }
  }
  return null;
}

function allPresent(labDir: string, rels: readonly string[]): boolean {
  return rels.every((rel) => existsSync(join(labDir, rel)));
}

/**
 * firered 真合成面探活：venv+torch、manifest 11 件权重在场、default 嗓参考在场。
 * torch import 探测 120s 预算：venv 冷 import torch 是秒级到十秒级（首跑 MPS 初始化不在 import 期）。
 */
export const FIRERED_VENV_PYTHON: string | null = resolveVenv(FIRERED_LAB, "torch", 120_000);
export const FIRERED_WEIGHTS_PRESENT =
  FIRERED_VENV_PYTHON !== null &&
  allPresent(FIRERED_LAB, [
    "models/FireRedTTS3/fireredtts3_base/model.safetensors",
    "models/FireRedTTS3/redae/model.safetensors",
    "models/FireRedTTS3/campp/campplus_voxceleb.bin",
    "models/FireRedTTS3/text_tokenizer/tokenizer.json",
  ]);
export const FIRERED_PROMPT_WAV = join(FIRERED_LAB, "prompts/prompt_2.wav");
/** prompt_2.wav 的官方转写（firered adapter default 嗓同源文案，克隆质量依赖转写与音频严格对应） */
export const FIRERED_PROMPT_TEXT = "对，所以说你现在的话，这个账单的话，你既然说能处理，那你就想办法处理掉。";
export const FIRERED_SYNTH = FIRERED_WEIGHTS_PRESENT && existsSync(FIRERED_PROMPT_WAV);

/** voxcpm 真合成面探活：venv+voxcpm 包 import、models 七件在场（safetensors 主权重非占位） */
export const VOXCPM_VENV_PYTHON: string | null = resolveVenv(VOXCPM_LAB, "voxcpm", 120_000);
export const VOXCPM_SYNTH =
  VOXCPM_VENV_PYTHON !== null &&
  allPresent(VOXCPM_LAB, [
    "models/model.safetensors",
    "models/audiovae.pth",
    "models/config.json",
    "models/tokenizer.json",
  ]);

export interface DaemonHandle {
  proc: ReturnType<typeof spawn>;
  client: Promise<DaemonClient>;
  /** 退出结局（SIGTERM/SIGKILL/自收割都会在这里落到 code/signal） */
  exit: Promise<{ code: number | null; signal: string | null }>;
  kill(signal: NodeJS.Signals): void;
}

/** 起 daemon 形态 shim 进程：返回句柄 + 就绪后的 socket 客户端（ready 帧收妥才 resolve） */
export function startDaemonShim(
  python: string,
  args: string[],
  opts: { env?: Record<string, string>; readyTimeoutMs: number },
): DaemonHandle {
  const proc = spawn(python, args, {
    stdio: "ignore",
    ...(opts.env !== undefined ? { env: { ...process.env, ...opts.env } } : {}),
  });
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    proc.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const sockPath = join(args[args.indexOf("--lab") + 1]!, "daemon.sock");
  const client = DaemonClient.connect(sockPath, opts.readyTimeoutMs, exit);
  return { proc, client, exit, kill: (s) => proc.kill(s) };
}

/**
 * daemon socket 客户端（验收直驱面）：连接（含解释器启动空窗重试）→ 收 ready →
 * 逐请求收帧（一行一请求，收至 done 尾帧或 error 终结）。
 * 行切分走 shift 消费——多帧收集重复计数的病理在 S5-2 套件实跑暴露过一次，这里直接钉死正确形态。
 */
export class DaemonClient {
  private readonly conn: net.Socket;
  private buf = "";
  private readonly lines: string[] = [];
  private streamEnded = false;
  private pendingResolve: ((line: string | null) => void) | null = null;

  private constructor(conn: net.Socket) {
    this.conn = conn;
    conn.on("data", (chunk) => {
      this.buf += chunk.toString("utf8");
      for (;;) {
        const cut = this.buf.indexOf("\n");
        if (cut < 0) break;
        const line = this.buf.slice(0, cut).trim();
        this.buf = this.buf.slice(cut + 1);
        if (line.length === 0) continue;
        if (this.pendingResolve !== null) {
          const r = this.pendingResolve;
          this.pendingResolve = null;
          r(line);
        } else {
          this.lines.push(line);
        }
      }
    });
    const end = () => {
      this.streamEnded = true;
      if (this.pendingResolve !== null) {
        const r = this.pendingResolve;
        this.pendingResolve = null;
        r(null);
      }
    };
    conn.on("close", end);
    conn.on("error", end);
  }

  /** 连接并收 ready 帧：ENOENT/ECONNREFUSED 重试到就绪或超时；daemon 提前死则一并报错 */
  static async connect(sockPath: string, timeoutMs: number, procExit?: Promise<{ code: number | null }>): Promise<DaemonClient> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const client = await DaemonClient.tryConnect(sockPath);
        const line = await client.nextLine(timeoutMs - (Date.now() - (deadline - timeoutMs)));
        if (line === null) throw new Error("daemon 在 ready 前断开连接");
        const ready = JSON.parse(line) as Record<string, unknown>;
        if (ready.type !== "ready") {
          client.conn.destroy();
          throw new Error(`首帧不是 ready：${line.slice(0, 200)}`);
        }
        client.readyFrame = ready;
        return client;
      } catch (error) {
        if (procExit !== undefined) {
          const settled = await Promise.race([procExit.then(() => "exited"), Promise.resolve("alive")]);
          if (settled === "exited") throw new Error(`daemon 进程已退出且未就绪：${String((error as Error).message)}`);
        }
        if (Date.now() >= deadline) throw error;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }

  private static tryConnect(sockPath: string): Promise<DaemonClient> {
    return new Promise((resolve, reject) => {
      const conn = net.connect(sockPath);
      conn.once("connect", () => {
        conn.setNoDelay(true);
        resolve(new DaemonClient(conn));
      });
      conn.once("error", reject);
    });
  }

  readyFrame: Record<string, unknown> = {};

  private nextLine(timeoutMs: number): Promise<string | null> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.streamEnded) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等待响应帧超时")), Math.max(1_000, timeoutMs));
      this.pendingResolve = (line) => {
        clearTimeout(timer);
        resolve(line);
      };
    });
  }

  /** 写一帧请求并收完整响应（audio 帧序列收至 done 或 error 即返）；EOF 抛错 */
  async request(req: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>[]> {
    const frames: Record<string, unknown>[] = [];
    this.conn.write(JSON.stringify(req) + "\n");
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const line = await this.nextLine(deadline - Date.now());
      if (line === null) throw new Error("daemon 在响应中 EOF");
      if (!line.startsWith("{")) continue;
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (msg.type === "audio" || msg.type === "error") {
        frames.push(msg);
        if (msg.type === "error" || msg.done === true) return frames;
      }
    }
  }

  close(): void {
    this.conn.destroy();
  }
}

/** base64 pcm → Int16Array（奇数字节 = 帧损坏，响亮失败，沿用 S4 校验纪律） */
export function decodePcmToInt16(pcmB64: string): Int16Array {
  const buf = Buffer.from(pcmB64, "base64");
  if (buf.byteLength % 2 !== 0) throw new Error(`pcm 字节数为奇（${buf.byteLength}）：协议帧损坏`);
  return new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
}
