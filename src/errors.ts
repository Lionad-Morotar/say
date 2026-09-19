/**
 * 引擎侧可预期失败的统一类型。编排层靠它把「合成没成」与「代码写错了」分开：
 * 前者走回退与非零退出，后者不该被 catch 成静默降级。
 */
export class EngineError extends Error {}

/** 执行器拓扑尚未实现的占位失败，常驻化落地时由真实实现取代 */
export class NotImplementedError extends Error {}

/**
 * 出声环节的失败，与合成失败分开：合成已经产出音频，
 * 回退层据此决定是否值得整段重来，而不是把两类失败混成一句「没成」。
 */
export class PlaybackError extends Error {}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
