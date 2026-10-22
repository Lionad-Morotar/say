import { SayError, synthesize } from "../lib/say-bridge.ts";

interface SynthesizeBody {
  text?: unknown;
  engine?: unknown;
  voice?: unknown;
}

export default defineEventHandler(async (event) => {
  const body = await readBody<SynthesizeBody>(event);
  const text = typeof body?.text === "string" ? body.text : "";
  const engine = typeof body?.engine === "string" && body.engine !== "" ? body.engine : undefined;
  const voice = typeof body?.voice === "string" && body.voice !== "" ? body.voice : undefined;

  let result;
  try {
    result = await synthesize({ text, engine, voice });
  } catch (e) {
    if (e instanceof SayError) {
      throw createError({ statusCode: 400, statusMessage: e.message });
    }
    throw e;
  }

  setHeaders(event, {
    "content-type": "audio/wav",
    "x-say-engine": result.engine,
    "x-say-daemon": result.daemonForm ?? "",
    "x-say-total-ms": String(result.totalMs ?? ""),
    "x-say-fallback": result.fallback ? "1" : "0",
    "cache-control": "no-store",
  });
  return result.wav;
});
