import { daemonFormOf } from "./daemon-trace.ts";
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

/**
 * SAY_DEBUG daemon 段（热启动）：把 daemon-trace 记的形态拼进摘要。
 * 词表 warm|cold(Xs)|per-call|cooldown|off 按蓝图钉死。
 * 形态按「路由到的引擎」查而非 outcome.engineName：回退到系统嗓后 engineName 已是 system，
 * 而形态记在被尝试的引擎名下——按 engineName 查会把「走过 daemon 层但降级了」一并抹掉。
 * 非 daemon 引擎（sherpa/system/zipvoice）无记账，整段省略——不写 daemon=n/a，
 * 让 grep daemon= 天然只命中四 shim-daemon 引擎的调用。
 * cold 的 Xs = 本调用实付加载窗（秒，一位小数），其余形态不带耗时。
 */
function daemonSegment(routedEngine: string): string {
  const trace = daemonFormOf(routedEngine);
  if (trace === null) return "";
  if (trace.form === "cold") {
    // 半进位走整数域：6.35 存成 6.3499…，直接 (ms/1000).toFixed(1) 会系统性舍出 6.3
    const secs = (Math.round((trace.coldMs ?? 0) / 100) / 10).toFixed(1);
    return ` daemon=cold(${secs}s)`;
  }
  return ` daemon=${trace.form}`;
}

/** SAY_DEBUG=1 的一行时序摘要：走没走回退、分了几块、daemon 什么形态、时间花在合成还是播放，一行看全 */
export function writeDebug(
  host: Host,
  config: ResolvedConfig,
  outcome: Outcome,
  voice: string | null,
  chunks: number,
  timing: Timing,
  routedEngine: string,
): void {
  if (!config.debug) return;
  const total = Math.round(host.now() - timing.started);
  host.writeStderr(
    `say: debug: engine=${outcome.engineName}${daemonSegment(routedEngine)} voice=${voice ?? "default"} chunks=${chunks} ` +
      `synth=${Math.round(timing.synth)}ms play=${Math.round(timing.play)}ms total=${total}ms\n`,
  );
}
