import { listVerdicts, resolveVerdictsRoot } from "../lib/verdicts.ts";

export default defineEventHandler(() =>
  listVerdicts(resolveVerdictsRoot(process.env.SAY_AUDITIONS_DIR, process.cwd())),
);
