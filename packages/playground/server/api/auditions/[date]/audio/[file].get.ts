import { readFileSync } from "node:fs";
import { AuditionDataError, resolveAudioPath, resolveAuditionsRoot } from "../../../../lib/auditions.ts";

export default defineEventHandler((event) => {
  const root = resolveAuditionsRoot();
  const date = getRouterParam(event, "date") ?? "";
  const file = getRouterParam(event, "file") ?? "";
  try {
    const p = resolveAudioPath(root, date, file);
    setHeaders(event, {
      "content-type": "audio/wav",
      "cache-control": "public, max-age=86400, immutable",
    });
    return readFileSync(p);
  } catch (e) {
    if (e instanceof AuditionDataError) {
      throw createError({ statusCode: 404, statusMessage: e.message });
    }
    throw e;
  }
});
