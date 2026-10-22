import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface SynthesizeOptions {
  text: string;
  engine?: string;
  voice?: string;
}

export interface SynthesisResult {
  wav: Buffer;
  /** 实际服务引擎（SAY_DEBUG 行归因，回退后可能是 system） */
  engine: string;
  daemonForm: string | null;
  totalMs: number | null;
  fallback: boolean;
}

export class SayError extends Error {
  constructor(
    public code: number | null,
    message: string,
  ) {
    super(message);
  }
}

/** 子进程形态的可注入 seam：默认实现 spawn `node bin/say`，测试注入 fake；code null = 被信号杀死 */
export type SayRunner = (args: string[]) => Promise<{ code: number | null; stderr: string }>;

const TEXT_LIMIT = 1000;

export function sayArgs(opts: { text: string; engine?: string; voice?: string; out: string }): string[] {
  const args: string[] = [];
  if (opts.engine) args.push("--engine", opts.engine);
  if (opts.voice) args.push("--voice", opts.voice);
  // `--` 先收 flag 面：`-` 开头的正文（如 "- 好的"）不触发 CLI 透传分支，
  // 否则整串 argv 会交给 /usr/bin/say 绕过神经链，产出系统嗓还冒充实况归因
  args.push("-o", opts.out, "--", opts.text);
  return args;
}

export function parseDebugLine(line: string): { engine: string; daemonForm: string | null; totalMs: number | null } | null {
  if (!line.startsWith("say: debug:")) return null;
  const kv = new Map<string, string>();
  for (const m of line.matchAll(/(\w+)=(\S+)/g)) {
    if (m[1] !== undefined && m[2] !== undefined) kv.set(m[1], m[2]);
  }
  const engine = kv.get("engine");
  if (!engine) return null;
  const total = kv.get("total");
  return {
    engine,
    daemonForm: kv.get("daemon") ?? null,
    totalMs: total !== undefined && total.endsWith("ms") ? Number(total.slice(0, -2)) : null,
  };
}

/** 仓库根：bin/say 与 src/ 所在地；dev cwd 在 packages/playground，向上找 bin/say */
export function resolveRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, "bin/say"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("未定位到仓库根（bin/say 不在上溯路径）");
}

function defaultRunner(repoRoot: string): SayRunner {
  return (args) =>
    new Promise((res, rej) => {
      const child = spawn(process.execPath, [join(repoRoot, "bin/say"), ...args], {
        cwd: repoRoot,
        env: { ...process.env, SAY_DEBUG: "1" },
      });
      let stderr = "";
      child.stderr.on("data", (c: Buffer) => {
        stderr += c;
        if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
      });
      child.on("error", rej);
      child.on("close", (code) => res({ code: code ?? null, stderr }));
    });
}

export async function synthesize(
  opts: SynthesizeOptions,
  deps: { runner?: SayRunner } = {},
): Promise<SynthesisResult> {
  const text = opts.text.trim();
  if (!text) throw new SayError(null, "text 不能为空");
  if (text.length > TEXT_LIMIT) throw new SayError(null, `text 超过 ${TEXT_LIMIT} 字上限`);

  const out = join(tmpdir(), `say-playground-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}.wav`);
  const runner = deps.runner ?? defaultRunner(resolveRepoRoot());
  try {
    const { code, stderr } = await runner(sayArgs({ ...opts, text, out }));
    if (code !== 0) throw new SayError(code, `say 退出码 ${code}: ${stderr.slice(-400)}`);
    const debug = stderr
      .split("\n")
      .map(parseDebugLine)
      .find((r): r is NonNullable<ReturnType<typeof parseDebugLine>> => r !== null);
    return {
      wav: readFileSync(out),
      engine: debug?.engine ?? opts.engine ?? "unknown",
      daemonForm: debug?.daemonForm ?? null,
      totalMs: debug?.totalMs ?? null,
      fallback: stderr.includes("say: fallback:"),
    };
  } finally {
    rmSync(out, { force: true });
  }
}
