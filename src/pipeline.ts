import { deliver, deliverAndExit, stagingPath, type Delivery, type Timing } from "./delivery.ts";
import type { RunDeps } from "./deps.ts";
import { SYSTEM_ENGINE } from "./engines/index.ts";
import { attemptSpeak, recover, speakWith, type Attempt } from "./fallback.ts";
import { EXIT_OK, fail, type Outcome } from "./report.ts";
import type { AudioOut, EngineAdapter, ResolvedConfig, SpeakOptions } from "./types.ts";
import { concatSamples } from "./wav.ts";

/** 一次合成调用的不变上下文。分块路径要在多个块之间传递同一套依赖，逐个参数传会传成八个 */
export interface SpeakContext {
  deps: RunDeps;
  config: ResolvedConfig;
  opts: SpeakOptions;
  delivery: Delivery;
  timing: Timing;
  /** 完整正文：分块中途一块都没交付出去时按全文回退，重说没有重复内容 */
  fullText: string;
}

/**
 * 回退那一腿的等待也要计入摘要，否则分项之和与 total 差出数秒到数十秒，
 * 看不出时间到底花在合成还是播放。引擎自己出声的那段是播放，
 * 交回产物、之后还要本层写盘或另起 afplay 的那段是合成。
 */
async function timedRecover(
  ctx: SpeakContext,
  engine: EngineAdapter | undefined,
  reason: string,
  text: string,
): Promise<Attempt> {
  const { host } = ctx.deps;
  const started = host.now();
  const recovered = await recover(ctx.deps, reason, engine, ctx.config, text, ctx.opts);
  const elapsed = host.now() - started;
  if (recovered.ok && recovered.out.type === "device") ctx.timing.play += elapsed;
  else ctx.timing.synth += elapsed;
  return recovered;
}

/**
 * 提前退出前等在飞的那块合成落地。它包着一层 fd 2 遮罩，窗口没收尾时写回退原因
 * 或失败原因就是写进 /dev/null；被丢弃的推理还会让进程在收尾之后多挂数秒才退出。
 * 推理无法取消，代价是最多多等一块的合成时间——失败路径上这换得来原因行真的可见。
 */
async function settle(ctx: SpeakContext, pending: Promise<Attempt> | null): Promise<void> {
  if (pending === null) return;
  const { host } = ctx.deps;
  const started = host.now();
  await pending;
  // 被丢弃的这块推理照样占了墙钟，不计进合成就又会在摘要里凭空少一段
  ctx.timing.synth += host.now() - started;
}

/** chunkable 是引擎对编排层的承诺：说好的裸样本却交回文件，块间就无从拼接 */
function chunkableViolation(engine: EngineAdapter, out: AudioOut): string {
  return `引擎 "${engine.name}" 声明可分块拼接却返回了 ${out.type} 产出`;
}

export async function speakOnce(ctx: SpeakContext, engine: EngineAdapter | undefined, text: string): Promise<Outcome> {
  const { host } = ctx.deps;
  const started = host.now();
  const attempt = await attemptSpeak(ctx.deps, engine, ctx.config, text, ctx.opts);
  ctx.timing.synth += host.now() - started;
  if (attempt.ok) {
    return {
      code: await deliverAndExit(host, attempt.out, ctx.delivery, ctx.timing),
      engineName: engine?.name ?? ctx.config.engine,
    };
  }
  const recovered = await timedRecover(ctx, engine, attempt.reason, text);
  if (!recovered.ok) return { code: fail(host, recovered.reason), engineName: ctx.config.engine };
  return { code: await deliverAndExit(host, recovered.out, ctx.delivery, ctx.timing), engineName: SYSTEM_ENGINE };
}

/** 整段回退：一块都没交付出去，重说全文没有重复内容 */
async function recoverWhole(ctx: SpeakContext, engine: EngineAdapter, reason: string): Promise<Outcome> {
  const recovered = await timedRecover(ctx, engine, reason, ctx.fullText);
  if (!recovered.ok) return { code: fail(ctx.deps.host, recovered.reason), engineName: engine.name };
  return {
    code: await deliverAndExit(ctx.deps.host, recovered.out, ctx.delivery, ctx.timing),
    engineName: SYSTEM_ENGINE,
  };
}

/**
 * 中途回退：前面的块已经播出去了，只把剩下的交给回退引擎。
 * 重播全文比漏掉后半段更糟，听众已经听过前半段了。
 * 退出码仍按「出过声即 0」的口径给，回退也不可用就把原因留在 stderr 上。
 */
async function recoverTail(ctx: SpeakContext, engine: EngineAdapter, reason: string, rest: string): Promise<Outcome> {
  const { host } = ctx.deps;
  const recovered = await timedRecover(ctx, engine, reason, rest);
  if (!recovered.ok) {
    host.writeStderr(`say: ${recovered.reason}\n`);
    return { code: EXIT_OK, engineName: engine.name };
  }
  const staged = await deliver(host, recovered.out, ctx.delivery, ctx.timing);
  if (!staged.delivered) return { code: fail(host, staged.error ?? "播放失败"), engineName: SYSTEM_ENGINE };
  return { code: EXIT_OK, engineName: SYSTEM_ENGINE };
}

/**
 * 落盘模式的分块：全部块合成完再拼成一个 wav。
 * 这里不流水，因为没有可以边等边做的事，交付物是单个文件，早写一块并不能早交付。
 */
async function mergeChunks(ctx: SpeakContext, engine: EngineAdapter, chunks: readonly string[]): Promise<Outcome> {
  const { host } = ctx.deps;
  const parts: Float32Array[] = [];
  let sampleRate = 0;
  for (const chunk of chunks) {
    const started = host.now();
    const attempt = await speakWith(engine, chunk, ctx.opts);
    ctx.timing.synth += host.now() - started;
    if (!attempt.ok) return recoverWhole(ctx, engine, attempt.reason);
    if (attempt.out.type !== "pcm") return recoverWhole(ctx, engine, chunkableViolation(engine, attempt.out));
    // 采样率不齐的样本直接拼接会整段变调，比失败更难察觉
    if (parts.length > 0 && attempt.out.sampleRate !== sampleRate) {
      return recoverWhole(
        ctx,
        engine,
        `块间采样率不一致（${sampleRate} 与 ${attempt.out.sampleRate}），拼接会变调`,
      );
    }
    sampleRate = attempt.out.sampleRate;
    parts.push(attempt.out.samples);
  }
  const merged: AudioOut = { type: "pcm", samples: concatSamples(parts), sampleRate };
  return { code: await deliverAndExit(host, merged, ctx.delivery, ctx.timing), engineName: engine.name };
}

/**
 * 出声卡模式的分块：播块 i 的同时合成块 i+1。
 * 合成快于播放（实测 RTF 0.37-0.54），因此流水线一起起来就不断流，
 * 整段耗时趋近于播放时长本身，而不是两者相加。
 * 同一模型实例上的两个并发合成实测安全：产物能量正常，总耗时还短于顺序执行。
 */
async function playChunks(ctx: SpeakContext, engine: EngineAdapter, chunks: readonly string[]): Promise<Outcome> {
  const { host } = ctx.deps;
  let pending: Promise<Attempt> | null = null;
  let index = 0;
  let sounded = false;
  while (index < chunks.length) {
    const mine = index;
    // speakWith 不抛错，未 await 的那个 promise 因此不会变成 unhandled rejection
    const current = pending ?? speakWith(engine, chunks[mine]!, ctx.opts);
    index += 1;
    pending = index < chunks.length ? speakWith(engine, chunks[index]!, ctx.opts) : null;

    const started = host.now();
    const attempt = await current;
    ctx.timing.synth += host.now() - started;
    if (!attempt.ok) {
      await settle(ctx, pending);
      return sounded
        ? recoverTail(ctx, engine, attempt.reason, chunks.slice(mine).join(" "))
        : recoverWhole(ctx, engine, attempt.reason);
    }
    const staged = await deliver(host, attempt.out, { ...ctx.delivery, staging: stagingPath(host, mine) }, ctx.timing);
    if (!staged.delivered) {
      await settle(ctx, pending);
      return { code: fail(host, staged.error ?? "播放失败"), engineName: engine.name };
    }
    sounded = true;
  }
  return { code: EXIT_OK, engineName: engine.name };
}

export async function speakChunked(ctx: SpeakContext, engine: EngineAdapter, chunks: readonly string[]): Promise<Outcome> {
  return ctx.delivery.target === null
    ? playChunks(ctx, engine, chunks)
    : mergeChunks(ctx, engine, chunks);
}
