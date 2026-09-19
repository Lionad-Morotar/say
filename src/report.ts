import type { Timing } from "./delivery.ts";
import type { Host } from "./host.ts";
import type { ResolvedConfig } from "./types.ts";

/**
 * 退出码口径。0 = 出过声或有产物，因此回退成功同样是 0；
 * 1 = 全程无声且无产物；2 = 用法错误，连合成都没启动；
 * 透传路径不走这套，原样继承 /usr/bin/say 的退出码。
 */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export interface Outcome {
  code: number;
  /** 真正出声或产出文件的引擎名。回退发生过后这里是回退引擎，摘要行因此能看出走了哪条路 */
  engineName: string;
}

/** 失败行的统一出口：`say: ` 前缀让脚本可以稳定 grep 到本工具自己的输出 */
export function fail(host: Host, message: string): number {
  host.writeStderr(`say: ${message}\n`);
  return EXIT_FAILURE;
}

/** SAY_DEBUG=1 的一行时序摘要：走没走回退、分了几块、时间花在合成还是播放，一行看全 */
export function writeDebug(
  host: Host,
  config: ResolvedConfig,
  outcome: Outcome,
  voice: string | null,
  chunks: number,
  timing: Timing,
): void {
  if (!config.debug) return;
  const total = Math.round(host.now() - timing.started);
  host.writeStderr(
    `say: debug: engine=${outcome.engineName} voice=${voice ?? "default"} chunks=${chunks} ` +
      `synth=${Math.round(timing.synth)}ms play=${Math.round(timing.play)}ms total=${total}ms\n`,
  );
}
