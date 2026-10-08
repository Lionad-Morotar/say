import type { DaemonEngine } from "./config.ts";

/**
 * SAY_DEBUG daemon 段的进程级形态记账（热启动 S6）：
 * 一次 CLI 调用 = 一个进程，daemon 形态在合成期发生、在摘要渲染期读取，
 * 两者隔着编排层多跳——用模块级单例记账而非逐层透传参数，接线面因此只动装配点。
 * 形态词表按蓝图票 06 钉死：warm | cold(Xs) | per-call | cooldown | off。
 */

/** 常驻形态五值：warm 直连命中、cold 本调用拉起加载、per-call 基础设施失败退路、cooldown 熔断冷却直拒、off 门关不装配 */
export type DaemonForm = "warm" | "cold" | "per-call" | "cooldown" | "off";

export interface DaemonTraceEntry {
  form: DaemonForm;
  /** 仅 cold 携带：本调用支付的加载窗秒数（渲染成 cold(Xs)） */
  coldMs: number | null;
}

/**
 * 覆盖序：低信息量形态不覆写高信息量记录。
 * cooldown(3) 在 per-call(2) 之上：冷却直拒是因、per-call 出声是果，摘要展示因；
 * warm/cold(4) 为终态：本调用一旦命中常驻，后续块偶发降级不回改成降级形态
 * （burst 中途 daemon 死掉时首块证据比末块噪音更贴「这次调用走没走热路」的观测意图）。
 */
const FORM_RANK: Readonly<Record<DaemonForm, number>> = {
  off: 1,
  "per-call": 2,
  cooldown: 3,
  warm: 4,
  cold: 4,
};

const entries = new Map<string, DaemonTraceEntry>();

export function recordDaemonForm(engine: DaemonEngine, form: DaemonForm, coldMs: number | null = null): void {
  const prev = entries.get(engine);
  if (prev !== undefined && FORM_RANK[prev.form] >= FORM_RANK[form]) return;
  entries.set(engine, { form, coldMs: form === "cold" ? coldMs : null });
}

/** outcome.engineName 查形态：非 daemon 引擎（sherpa/system/zipvoice）无记录，渲染面据此省略 daemon 段 */
export function daemonFormOf(engine: string): DaemonTraceEntry | null {
  return entries.get(engine) ?? null;
}

/** 测试专用：进程单例会跨用例泄漏，逐用例起点归零 */
export function resetDaemonTrace(): void {
  entries.clear();
}
