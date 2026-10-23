import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { orderChoiceToSource } from "../../shared/blind.ts";

export { orderChoiceToSource };

export interface VerdictSource {
  engine: string;
  voice: string;
  /** 档期目录内相对路径（活体源为 audio/live-<id>-<side>.wav，离线可自证） */
  audio: string;
}

export interface VerdictSession {
  id: string;
  createdAt: string;
  prompt: string;
  sources: { a: VerdictSource; b: VerdictSource };
  /** 盲听播放序：ab = 先 A 后 B，ba = 先 B 后 A */
  order: "ab" | "ba";
  /** 揭盲后的真实裁决：a / b / tie */
  choice: "a" | "b" | "tie";
  note: string;
}

export interface DateVerdicts {
  date: string;
  sessions: VerdictSession[];
}

export class VerdictDataError extends Error {}

const DATE_RE = /^\d{6}$/;
const ID_RE = /^[a-z0-9-]+$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parseSession(v: unknown, where: string): VerdictSession {
  if (!isRecord(v)) throw new VerdictDataError(`${where} session 非对象`);
  const str = (x: unknown): string => (typeof x === "string" ? x : "");
  const srcOf = (x: unknown, side: string): VerdictSource => {
    if (!isRecord(x)) throw new VerdictDataError(`${where} 源 ${side} 非对象`);
    return { engine: str(x.engine), voice: str(x.voice), audio: str(x.audio) };
  };
  const order = str(v.order);
  const choice = str(v.choice);
  if (order !== "ab" && order !== "ba") throw new VerdictDataError(`${where} order 非法: ${order}`);
  if (choice !== "a" && choice !== "b" && choice !== "tie") {
    throw new VerdictDataError(`${where} choice 非法: ${choice}`);
  }
  return {
    id: str(v.id),
    createdAt: str(v.createdAt),
    prompt: str(v.prompt),
    sources: { a: srcOf((v.sources as Record<string, unknown>)?.a, "a"), b: srcOf((v.sources as Record<string, unknown>)?.b, "b") },
    order,
    choice,
    note: str(v.note),
  };
}

function dateDir(root: string, date: string): string {
  if (!DATE_RE.test(date)) throw new VerdictDataError(`非法档期目录名: ${date}`);
  return join(root, date);
}

export function loadVerdicts(root: string, date: string): DateVerdicts {
  const file = join(dateDir(root, date), "verdicts.json");
  if (!existsSync(file)) return { date, sessions: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new VerdictDataError(`${date} verdicts.json 非合法 JSON: ${(e as Error).message}`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.sessions)) {
    throw new VerdictDataError(`${date} verdicts.json 顶层形状不对`);
  }
  return { date, sessions: parsed.sessions.map((s, i) => parseSession(s, `${date}#${i}`)) };
}

export function listVerdicts(root: string): DateVerdicts[] {
  const out: DateVerdicts[] = [];
  for (const dir of existsSync(root) ? readdirSync(root, { withFileTypes: true }) : []) {
    if (!dir.isDirectory() || !DATE_RE.test(dir.name)) continue;
    const file = join(root, dir.name, "verdicts.json");
    if (!existsSync(file)) continue;
    try {
      out.push(loadVerdicts(root, dir.name));
    } catch (e) {
      console.warn(`跳过坏裁决档 ${dir.name}: ${(e as Error).message}`);
    }
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** 追加串行锁：读-改-写整覆写下并发 POST 互相覆盖会丢裁决，module 级链排队 */
let appendChain: Promise<void> = Promise.resolve();

/** 原子追加：tmp 写入后 rename，读档期不读到半截；经串行锁防并发覆盖 */
export function appendVerdict(root: string, date: string, s: VerdictSession): Promise<void> {
  if (!ID_RE.test(s.id)) throw new VerdictDataError(`非法 session id: ${s.id}`);
  const run = async () => {
    const dir = dateDir(root, date);
    mkdirSync(join(dir, "audio"), { recursive: true });
    const current = loadVerdicts(root, date);
    const next = { date, sessions: [...current.sessions, s] };
    const file = join(dir, "verdicts.json");
    const tmp = join(dir, `verdicts.json.${s.id}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, file);
  };
  appendChain = appendChain.then(run, run);
  return appendChain;
}

export function saveLiveAudio(root: string, date: string, id: string, side: "a" | "b", bytes: Buffer): string {
  if (!ID_RE.test(id)) throw new VerdictDataError(`非法 session id: ${id}`);
  const audioDir = join(dateDir(root, date), "audio");
  mkdirSync(audioDir, { recursive: true });
  const rel = `audio/live-${id}-${side}.wav`;
  writeFileSync(join(audioDir, `live-${id}-${side}.wav`), bytes);
  return rel;
}

export function todayDirName(now = new Date()): string {
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

export function resolveVerdictsRoot(envDir: string | undefined, cwd: string): string {
  if (envDir) return resolve(envDir);
  let dir = cwd;
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, "docs/audition");
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new VerdictDataError("未定位到 docs/audition（可用 SAY_AUDITIONS_DIR 显式指定）");
}
