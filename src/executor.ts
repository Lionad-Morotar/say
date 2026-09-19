import { NotImplementedError } from "./errors.ts";
import type { AudioOut, ExecutorKind, SynthesisExecutor, SynthTask } from "./types.ts";

/**
 * 合成执行器三态接口：进程内 / 子进程 / 常驻。
 * 三态是「合成在哪个进程里发生」这一个维度的扩展点，编排层只认 SynthesisExecutor，
 * 因此把进程内推理换成常驻服务时只需换这里的实现，不动引擎适配与编排。
 */
export function defineExecutor(
  kind: ExecutorKind,
  synthesize: (task: SynthTask) => Promise<AudioOut>,
): SynthesisExecutor {
  if (kind === "daemon") {
    // 常驻化的收益点是把模型载入摊薄到多次调用；短文本经进程内推理已在体验预算内，
    // 长文本先靠分块流水把首块出声提前。两者都不够时再接常驻，届时只增实现不改调用方。
    throw new NotImplementedError("常驻执行器尚未实现：进程内推理与分块流水仍不满足延迟要求时再接线");
  }
  return { kind, synthesize };
}
