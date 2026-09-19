import { closeSync, openSync } from "node:fs";

const STDERR_FD = 2;

/**
 * 在 run 执行期间把 fd 2 指向 /dev/null，结束后原样恢复。
 *
 * native 推理库直接写 fd 2，绕开 process.stderr，因此 JS 层重定向拦不住；
 * 而加载模型每次都会吐一行上游词典警告，`say` 成功时却应当静默，只能在描述符层面遮住。
 * 用 /dev/fd/2 重新打开来备份原目标而不是 dup：Node 没有暴露 dup2。
 * 备份打不开（无 /dev/fd 的平台）时直接放行，宁可多一行噪声也不要吞掉错误。
 */
export async function withStderrMuted<T>(run: () => Promise<T>): Promise<T> {
  let backup: number;
  try {
    backup = openSync("/dev/fd/2", "a");
  } catch {
    return run();
  }

  closeSync(STDERR_FD);
  // POSIX 保证返回最小可用描述符，刚空出的 2 必然被 /dev/null 占到
  const sink = openSync("/dev/null", "w");
  try {
    return await run();
  } finally {
    closeSync(sink);
    openSync(`/dev/fd/${backup}`, "a");
    closeSync(backup);
  }
}
