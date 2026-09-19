import { join } from "node:path";
import { messageOf } from "./errors.ts";
import type { Host } from "./host.ts";
import { playFile } from "./player.ts";
import { EXIT_OK, fail } from "./report.ts";
import type { AudioOut } from "./types.ts";
import { encodeWav } from "./wav.ts";

export interface Delivery {
  /** `-o` 的最终目标；null 表示要出声卡而不是落盘 */
  target: string | null;
  /** 目标的 PID 临时名，引擎自己写盘时用的就是它 */
  temp: string | null;
  /** 出声卡时的暂存 wav 落点 */
  staging: string;
}

export type DeliveryResult = { delivered: boolean; error: string | null };

export const DELIVERED: DeliveryResult = { delivered: true, error: null };

/**
 * 时序摘要的原料。synth 是「等合成」的墙钟时间：流水播放下后续块在播放期间已经合成完，
 * 这一段就趋近于零，因此它直接反映流水线有没有被合成拖住。
 * play 只统计编排层自己驱动的 afplay，引擎内部出声的那段无从计时。
 */
export interface Timing {
  started: number;
  synth: number;
  play: number;
}

export function startTiming(host: Host): Timing {
  return { started: host.now(), synth: 0, play: 0 };
}

/**
 * 播放用的暂存 wav。带 PID 是为了并发调用各写各的，互不覆盖对方正在播的文件；
 * 分块播放再带块序号，否则下一块会在上一块还在播的时候把它截断。
 */
export function stagingPath(host: Host, chunk: number | null): string {
  return join(host.tmpDir, chunk === null ? `say-${host.pid}.wav` : `say-${host.pid}-${chunk}.wav`);
}

/** 残留的临时文件只是脏，清理失败不该盖掉真正的失败原因 */
async function discard(host: Host, path: string): Promise<void> {
  try {
    await host.removeFile(path);
  } catch {
    // 目标目录已经出问题了，再多一个删不掉的文件不改变结论
  }
}

/**
 * 临时名 → 目标名的原子改名：读者要么看到旧文件要么看到完整新文件，不会读到半截。
 * 改名失败要顺手清掉临时名，否则反复失败的调用会在目标目录攒出一堆孤儿 `.tmp`。
 */
async function renameInto(host: Host, temp: string, target: string): Promise<DeliveryResult> {
  try {
    await host.renameFile(temp, target);
    return DELIVERED;
  } catch (error) {
    await discard(host, temp);
    return { delivered: false, error: `写入 ${target} 失败：${messageOf(error)}` };
  }
}

async function deliverPcm(
  host: Host,
  out: Extract<AudioOut, { type: "pcm" }>,
  delivery: Delivery,
  timing: Timing,
): Promise<DeliveryResult> {
  const bytes = encodeWav(out.samples, out.sampleRate);
  const { target, temp, staging } = delivery;
  if (target !== null && temp !== null) {
    try {
      await host.writeFile(temp, bytes);
    } catch (error) {
      // 写失败同样要清临时名：writeFile 先 O_CREAT|O_TRUNC 建文件再写，
      // ENOSPC 这类抛在写入阶段的错误已经留下半截文件，而每次失败都是新 PID 新名字，会持续累积
      await discard(host, temp);
      return { delivered: false, error: `写入 ${target} 失败：${messageOf(error)}` };
    }
    return renameInto(host, temp, target);
  }
  try {
    await host.writeFile(staging, bytes);
    const started = host.now();
    await playFile(host, staging);
    timing.play += host.now() - started;
    return DELIVERED;
  } catch (error) {
    return { delivered: false, error: messageOf(error) };
  } finally {
    await discard(host, staging);
  }
}

/** 把引擎产出变成交付物：pcm 由本层封容器并写盘或播放，file 改名到目标，device 已经出声 */
export async function deliver(
  host: Host,
  out: AudioOut,
  delivery: Delivery,
  timing: Timing,
): Promise<DeliveryResult> {
  if (out.type === "pcm") return deliverPcm(host, out, delivery, timing);
  const { target } = delivery;
  if (out.type === "device") return DELIVERED;
  // 要出声卡却只拿到一个文件：没人播它，交付等于没发生。
  // 判成功的话退出码是 0 而全程无声，比失败更难发现
  if (target === null) return { delivered: false, error: `引擎把产物写到了 ${out.path}，这次要的却是出声卡` };
  if (out.path === target) return DELIVERED;
  return renameInto(host, out.path, target);
}

export async function deliverAndExit(
  host: Host,
  out: AudioOut,
  delivery: Delivery,
  timing: Timing,
): Promise<number> {
  const result = await deliver(host, out, delivery, timing);
  if (!result.delivered) return fail(host, result.error ?? "产物交付失败");
  return EXIT_OK;
}
