import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export interface VerdictEntry {
  key: string;
  engine: string;
  voice: string;
  reason: string;
}

export interface PlayCell {
  locale: string;
  voice: string;
  kind: "play";
  audio: string;
  label: string;
  flags: string[];
  note?: string;
}

export interface AwaitCell {
  locale: string;
  voice: string;
  kind: "await";
  note: string;
  flags: string[];
}

export interface NaCell {
  locale: string;
  voice: string;
  kind: "na";
  flags: string[];
}

/** 播放中的格子：play 格带上引擎名，播放器与裁决面据此自述 */
export interface PlayingCell extends PlayCell {
  engine: string;
}

export type MatrixCell = PlayCell | AwaitCell | NaCell;

export interface EngineRow {
  name: string;
  tag: string;
  cells: MatrixCell[];
}

export interface TextRow {
  [field: string]: string;
}

export interface AuditionSummary {
  date: string;
  title: string;
  edition: string;
  verdicts: VerdictEntry[];
}

export interface AuditionManifest extends AuditionSummary {
  source: string;
  summary: string;
  engines: EngineRow[];
  genderTable: TextRow[];
  engineProps: TextRow[];
  fixRecords: string[];
  openItems: string[];
}

/** dev/preview 的 cwd 都在 packages/playground，仓库根在上两层；向上最多走四层容忍 cwd 变体 */
export function resolveAuditionsRoot(): string {
  const fromEnv = process.env.SAY_AUDITIONS_DIR;
  if (fromEnv) return resolve(fromEnv);
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, "docs/audition");
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("未定位到 docs/audition（可用 SAY_AUDITIONS_DIR 显式指定）");
}

const DATE_RE = /^\d{6}$/;
const AUDIO_RE = /^[a-z0-9-]+\.wav$/;

export class AuditionDataError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function parseCell(v: unknown, where: string): MatrixCell {
  if (!isRecord(v)) throw new AuditionDataError(`${where} 格子非对象`);
  const locale = str(v.locale);
  const voice = str(v.voice);
  const kind = str(v.kind);
  if (!locale || !voice) throw new AuditionDataError(`${where} 格子缺坐标`);
  const flags = Array.isArray(v.flags) ? v.flags.filter((f): f is string => typeof f === "string") : [];
  if (kind === "na") return { locale, voice, kind: "na", flags };
  const note = str(v.note);
  if (kind === "await") return { locale, voice, kind: "await", note, flags };
  if (kind === "play") {
    const audio = str(v.audio);
    const label = str(v.label);
    if (!audio || !label) throw new AuditionDataError(`${where}/${locale}/${voice} play 格缺 audio/label`);
    const cell: PlayCell = { locale, voice, kind: "play", audio, label, flags };
    if (note) cell.note = note;
    return cell;
  }
  throw new AuditionDataError(`${where}/${locale}/${voice} 未知格子 kind: ${kind}`);
}

function parseManifest(raw: string, where: string): AuditionManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new AuditionDataError(`${where} manifest.json 非合法 JSON: ${(e as Error).message}`);
  }
  if (!isRecord(parsed)) throw new AuditionDataError(`${where} manifest.json 顶层非对象`);
  const verdicts = Array.isArray(parsed.verdicts)
    ? parsed.verdicts.map((v): VerdictEntry => {
        if (!isRecord(v)) throw new AuditionDataError(`${where} verdict 非对象`);
        return {
          key: str(v.key),
          engine: str(v.engine),
          voice: str(v.voice),
          reason: str(v.reason),
        };
      })
    : [];
  const engines = Array.isArray(parsed.engines)
    ? parsed.engines.map((e): EngineRow => {
        if (!isRecord(e)) throw new AuditionDataError(`${where} 引擎行非对象`);
        return {
          name: str(e.name),
          tag: str(e.tag),
          cells: Array.isArray(e.cells) ? e.cells.map((c, i) => parseCell(c, `${where}/${str(e.name) ?? "engine"}#${i}`)) : [],
        };
      })
    : [];
  const textRows = (v: unknown): TextRow[] =>
    Array.isArray(v)
      ? v.map((r) => {
          if (!isRecord(r)) throw new AuditionDataError(`${where} 表行非对象`);
          const row: TextRow = {};
          for (const [k, val] of Object.entries(r)) row[k] = str(val);
          return row;
        })
      : [];
  const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map((s) => str(s)) : []);
  return {
    date: str(parsed.date),
    title: str(parsed.title),
    edition: str(parsed.edition),
    summary: str(parsed.summary),
    source: str(parsed.source),
    verdicts,
    engines,
    genderTable: textRows(parsed.genderTable),
    engineProps: textRows(parsed.engineProps),
    fixRecords: strList(parsed.fixRecords),
    openItems: strList(parsed.openItems),
  };
}

export function listAuditions(root: string): AuditionSummary[] {
  const summaries: AuditionSummary[] = [];
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory() || !DATE_RE.test(d.name)) continue;
    const file = join(root, d.name, "manifest.json");
    if (!existsSync(file)) continue;
    try {
      summaries.push(parseManifest(readFileSync(file, "utf8"), d.name));
    } catch (e) {
      console.warn(`跳过坏档期 ${d.name}: ${(e as Error).message}`);
    }
  }
  return summaries
    .map(({ date, title, edition, verdicts }) => ({ date, title, edition, verdicts }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

export function readManifest(root: string, date: string): AuditionManifest {
  if (!DATE_RE.test(date)) throw new AuditionDataError(`非法档期目录名: ${date}`);
  const file = join(root, date, "manifest.json");
  if (!existsSync(file)) throw new AuditionDataError(`档期不存在: ${date}`);
  return parseManifest(readFileSync(file, "utf8"), date);
}

export function resolveAudioPath(root: string, date: string, file: string): string {
  if (!DATE_RE.test(date)) throw new AuditionDataError(`非法档期目录名: ${date}`);
  if (!AUDIO_RE.test(file)) throw new AuditionDataError(`非法音频文件名: ${file}`);
  const p = join(root, date, "audio", file);
  if (!existsSync(p)) throw new AuditionDataError(`音频不存在: ${file}`);
  return p;
}
