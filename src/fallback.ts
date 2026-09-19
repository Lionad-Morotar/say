import type { RunDeps } from "./deps.ts";
import { SYSTEM_ENGINE } from "./engines/index.ts";
import { messageOf } from "./errors.ts";
import type { AudioOut, EngineAdapter, ResolvedConfig, SpeakOptions } from "./types.ts";

export type Attempt = { ok: true; out: AudioOut } | { ok: false; reason: string };

/** 回退原因行的固定前缀，脚本可以据此稳定 grep 到「这次不是主引擎出的声」 */
export const FALLBACK_PREFIX = "fallback: ";

/** 合成失败不是异常而是回退的触发条件，因此在这一层就把它收敛成值 */
export async function speakWith(engine: EngineAdapter, text: string, opts: SpeakOptions): Promise<Attempt> {
  try {
    return { ok: true, out: await engine.speak(text, opts) };
  } catch (error) {
    return { ok: false, reason: `引擎 "${engine.name}" 合成失败：${messageOf(error)}` };
  }
}

export async function attemptSpeak(
  deps: RunDeps,
  engine: EngineAdapter | undefined,
  config: ResolvedConfig,
  text: string,
  opts: SpeakOptions,
): Promise<Attempt> {
  if (engine === undefined) {
    return {
      ok: false,
      reason: `未登记的引擎 "${config.engine}"（已登记：${deps.registry.names().join(", ") || "无"}）`,
    };
  }
  const availability = await engine.isAvailable(opts.voice);
  if (!availability.ok) {
    return { ok: false, reason: `引擎 "${engine.name}" 不可用：${availability.reason}` };
  }
  return speakWith(engine, text, opts);
}

/**
 * 回退到系统嗓。say 的可用性下限是「总能出声」：神经引擎缺资产、产出静音或直接抛错，
 * 都不该让调用方哑掉。回退成功即算出过声，因此 exit 0，只留一行带固定前缀的原因。
 * 不回退到自己：同一次失败重试一遍只会多一行原因，不会多一分出声机会。
 */
export async function recover(
  deps: RunDeps,
  reason: string,
  primary: EngineAdapter | undefined,
  config: ResolvedConfig,
  text: string,
  opts: SpeakOptions,
): Promise<Attempt> {
  if (config.fallback === "off") return { ok: false, reason };
  const backup = deps.registry.get(SYSTEM_ENGINE);
  if (backup === undefined) {
    return { ok: false, reason: `${reason}；回退引擎 "${SYSTEM_ENGINE}" 未登记` };
  }
  if (primary !== undefined && backup.name === primary.name) return { ok: false, reason };
  const availability = await backup.isAvailable(opts.voice);
  if (!availability.ok) {
    return { ok: false, reason: `${reason}；回退引擎 "${backup.name}" 也不可用：${availability.reason}` };
  }
  deps.host.writeStderr(`say: ${FALLBACK_PREFIX}${reason}\n`);
  return speakWith(backup, text, opts);
}
