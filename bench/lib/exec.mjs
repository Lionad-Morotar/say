// 子进程执行与计时：所有真实执行经此采集 exit/duration/stderr，杜绝「未执行却有数字」。
import { spawn } from "node:child_process";
import { nowIso } from "./log.mjs";

/**
 * @param {string[]} cmd argv 数组（cmd[0] 为可执行文件）
 * @param {{cwd?: string, timeoutMs?: number, env?: NodeJS.ProcessEnv, input?: string}} [opts]
 * @returns {Promise<{exit: number|null, signal: string|null, started: string, ended: string, durationMs: number, stdout: string, stderrTail: string, cmdStr: string}>}
 */
export function runCmd(cmd, opts = {}) {
  const started = nowIso();
  const t0 = performance.now();
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = opts.timeoutMs
      ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs)
      : null;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    if (opts.input != null) child.stdin.write(opts.input);
    child.stdin.end();
    child.on("close", (exit, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        exit,
        signal,
        started,
        ended: nowIso(),
        durationMs: Math.round(performance.now() - t0),
        stdout,
        stderrTail: stderr.slice(-500),
        cmdStr: cmd.map(shellQuote).join(" "),
      });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({
        exit: null,
        signal: null,
        started,
        ended: nowIso(),
        durationMs: Math.round(performance.now() - t0),
        stdout,
        stderrTail: (stderr + String(err)).slice(-500),
        cmdStr: cmd.map(shellQuote).join(" "),
      });
    });
  });
}

function shellQuote(arg) {
  return /[^A-Za-z0-9_@%+=:,./-]/.test(arg) ? `'${arg.replace(/'/g, "'\\''")}'` : arg;
}
