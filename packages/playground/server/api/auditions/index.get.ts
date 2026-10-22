import { listAuditions, resolveAuditionsRoot } from "../../lib/auditions.ts";

export default defineEventHandler(() => listAuditions(resolveAuditionsRoot()));
