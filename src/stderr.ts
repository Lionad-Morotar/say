import { closeSync, openSync } from "node:fs";

const STDERR_FD = 2;

/**
 * 真正的 stderr 目标，第一次遮罩时固定下来并常驻一个描述符。
 * 不能每次遮罩都备份「当时的 fd 2」：遮罩窗口会重叠（分块流水下合成块 i+1 与播放块 i 并行），
 * 后开的窗口看到的 fd 2 已经是 /dev/null，它收尾时就会把 /dev/null 装回去，
 * 此后整个进程的 stderr 静默丢失，连回退原因行都看不见。
 */
let original: number | null = null;

/** 未收尾的遮罩层数。归零才真正恢复，重叠窗口因此不会互相踩 */
let depth = 0;

function captureOriginal(): number | null {
  if (original !== null) return original;
  try {
    // 用 /dev/fd/2 重新打开来固定原目标而不是 dup：Node 没有暴露 dup2
    original = openSync("/dev/fd/2", "a");
  } catch {
    // 无 /dev/fd 的平台：宁可多一行噪声也不要吞掉错误
    return null;
  }
  return original;
}

/**
 * 在 run 执行期间把 fd 2 指向 /dev/null，最外层收尾时恢复。
 *
 * native 推理库直接写 fd 2，绕开 process.stderr，因此 JS 层重定向拦不住；
 * 而加载模型每次都会吐一行上游词典警告，`say` 成功时却应当静默，只能在描述符层面遮住。
 */
export async function withStderrMuted<T>(run: () => Promise<T>): Promise<T> {
  const source = captureOriginal();
  if (source === null) return run();

  if (depth === 0) {
    closeSync(STDERR_FD);
    // POSIX 保证返回最小可用描述符，刚空出的 2 必然被 /dev/null 占到
    openSync("/dev/null", "w");
  }
  depth += 1;
  try {
    return await run();
  } finally {
    depth -= 1;
    if (depth === 0) {
      closeSync(STDERR_FD);
      openSync(`/dev/fd/${source}`, "a");
    }
  }
}
