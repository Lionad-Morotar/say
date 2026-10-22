import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  appendVerdict,
  resolveVerdictsRoot,
  saveLiveAudio,
  todayDirName,
  VerdictDataError,
  type VerdictSession,
} from "../lib/verdicts.ts";

interface SourceBody {
  engine?: unknown;
  voice?: unknown;
  wavB64?: unknown;
}

export default defineEventHandler(async (event) => {
  const body = await readBody<{
    date?: unknown;
    prompt?: unknown;
    a?: SourceBody;
    b?: SourceBody;
    order?: unknown;
    choice?: unknown;
    note?: unknown;
  }>(event);

  const str = (x: unknown): string => (typeof x === "string" ? x : "");
  const date = typeof body?.date === "string" && /^\d{6}$/.test(body.date) ? body.date : todayDirName();
  const prompt = str(body?.prompt).trim();
  const order = str(body?.order);
  const choice = str(body?.choice);
  const note = str(body?.note);

  if (!prompt) throw createError({ statusCode: 400, statusMessage: "prompt 不能为空" });
  if (order !== "ab" && order !== "ba") throw createError({ statusCode: 400, statusMessage: "order 非法" });
  if (choice !== "a" && choice !== "b" && choice !== "tie") {
    throw createError({ statusCode: 400, statusMessage: "choice 非法" });
  }

  const src = (x: SourceBody | undefined, side: "a" | "b") => {
    const engine = str(x?.engine);
    // voice 允许留空（system/默认链场景），规范化为 default 落档
    const voice = str(x?.voice) || "default";
    const wavB64 = str(x?.wavB64);
    if (!engine || !wavB64) {
      throw createError({ statusCode: 400, statusMessage: `源 ${side} 缺 engine/wavB64` });
    }
    const bytes = Buffer.from(wavB64, "base64");
    // RIFF 魔数 + offset 8 的 WAVE 魔数双查：只认真 wav，改后缀的垃圾字节挡在档外
    if (
      bytes.length < 12 ||
      bytes.subarray(0, 4).toString("latin1") !== "RIFF" ||
      bytes.subarray(8, 12).toString("latin1") !== "WAVE"
    ) {
      throw createError({ statusCode: 400, statusMessage: `源 ${side} 非 RIFF/WAVE 字节` });
    }
    return { engine, voice, bytes };
  };

  const root = resolveVerdictsRoot(process.env.SAY_AUDITIONS_DIR, process.cwd());
  const id = `v-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  const a = src(body?.a, "a");
  const b = src(body?.b, "b");

  let session: VerdictSession;
  try {
    const audioA = saveLiveAudio(root, date, id, "a", a.bytes);
    const audioB = saveLiveAudio(root, date, id, "b", b.bytes);
    session = {
      id,
      createdAt: new Date().toISOString(),
      prompt,
      sources: { a: { engine: a.engine, voice: a.voice, audio: audioA }, b: { engine: b.engine, voice: b.voice, audio: audioB } },
      order,
      choice,
      note,
    };
    appendVerdict(root, date, session);
  } catch (e) {
    // 半途失败不留孤儿音频：session 未成，已写两侧清理后按原错误形态抛出
    rmSync(join(root, date, "audio", `live-${id}-a.wav`), { force: true });
    rmSync(join(root, date, "audio", `live-${id}-b.wav`), { force: true });
    if (e instanceof VerdictDataError) throw createError({ statusCode: 400, statusMessage: e.message });
    throw e;
  }
  return { date, session };
});
