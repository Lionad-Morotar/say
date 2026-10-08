import type { CliRequest } from "./cli.ts";
import { DAEMON_ENGINES, type DaemonEngine } from "./config.ts";
import type { RunDeps } from "./deps.ts";
import { EXIT_OK } from "./report.ts";
import { probeDaemonStatus, type DaemonStatusRow } from "./daemon-status.ts";
import { runDaemonStop } from "./daemon-stop.ts";

/**
 * `say daemon ls` 编排（用户面）：逐引擎只读探测，一行一态。
 * 探测彼此独立并发跑（各引擎的 sock 判据互不相关），全表耗时 ≈ 单引擎探测耗时。
 * 输出走 writeStdout（管理命令的清单通道，与 engine ls 同形），stdout 保持管道友好——
 * 表头与行都是数据，错误归因才进 stderr。
 */

/** 人读内存：KB 起跳 MB/GB 一档小数，与常驻化报告的常驻体量口径同字面（~10GB、~4.6GB） */
export function formatRss(rssKb: number | null): string {
  if (rssKb === null) return "-";
  if (rssKb < 1024) return `${rssKb}KB`;
  const mb = rssKb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)}MB`;
  return `${(mb / 1024).toFixed(1)}GB`;
}

/** 表格行渲染：列宽钉死保证脚本可切列，note 不参与对齐（允许尾部长文） */
export function renderStatusTable(rows: readonly DaemonStatusRow[]): string {
  const header = ["ENGINE", "STATE", "PID", "UP", "RSS", "NOTE"].join("  ");
  const lines = rows.map((row) =>
    [
      row.engine.padEnd(10),
      row.state.padEnd(11),
      String(row.pid ?? "-").padStart(7),
      (row.etime ?? "-").padEnd(10),
      formatRss(row.rssKb).padStart(8),
      row.note,
    ].join("  "),
  );
  return [header, ...lines].join("\n");
}

export async function runDaemonLs(deps: RunDeps): Promise<number> {
  const rows = await Promise.all(DAEMON_ENGINES.map((engine: DaemonEngine) => probeDaemonStatus(deps.host, engine)));
  deps.host.writeStdout(renderStatusTable(rows) + "\n");
  return EXIT_OK;
}

/** daemon 子命令分派入口（speak.ts 经 request.kind === "daemon" 送达） */
export async function runDaemonCommand(deps: RunDeps, request: Extract<CliRequest, { kind: "daemon" }>): Promise<number> {
  if (request.action === "ls") return runDaemonLs(deps);
  if (request.action === "stop") return runDaemonStop(deps.host, request.target);
  return EXIT_OK; // 类型收敛兜底：新动作接入必须显式分支，不给静默空转留缝
}
