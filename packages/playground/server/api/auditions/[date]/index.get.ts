import { AuditionDataError, readManifest, resolveAuditionsRoot } from "../../../lib/auditions.ts";

export default defineEventHandler((event) => {
  const root = resolveAuditionsRoot();
  const date = getRouterParam(event, "date") ?? "";
  try {
    return readManifest(root, date);
  } catch (e) {
    if (e instanceof AuditionDataError) {
      throw createError({ statusCode: 404, statusMessage: e.message });
    }
    throw e;
  }
});
