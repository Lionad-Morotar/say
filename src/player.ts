import { PlaybackError } from "./errors.ts";
import type { Host } from "./host.ts";

export const AFPLAY_BIN = "/usr/bin/afplay";

/**
 * 送出声卡。afplay 会阻塞到播完为止，且实测有约 1 秒的固定启动开销——
 * 分块流水的分块预算据此设定：块太小时每块都要再付一次这 1 秒的静音。
 * 不用 CoreAudio 直连是为了少一条 native 依赖面，1 秒开销在长文本分块下可摊薄。
 */
export async function playFile(host: Host, path: string, afplayBin: string = AFPLAY_BIN): Promise<void> {
  const outcome = await host.spawn(afplayBin, [path], {});
  if (outcome.exitCode === 0) return;
  const cause =
    outcome.signal !== null
      ? `被信号 ${outcome.signal} 终止`
      : `退出码 ${outcome.exitCode === null ? "未知" : outcome.exitCode}`;
  const detail = outcome.stderr.trim();
  throw new PlaybackError(`播放 ${path} 失败（${cause}）${detail.length > 0 ? `：${detail}` : ""}`);
}
