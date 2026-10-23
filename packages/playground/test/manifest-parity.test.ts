import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractManifest } from "../../../scripts/extract-audition-manifest.mjs";
import type { AuditionManifest } from "../server/lib/auditions.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dateDir = resolve(here, "../../../docs/audition/261007");
const html = readFileSync(resolve(dateDir, "engine-v2-voice-matrix.html"), "utf8");
const manifestText = readFileSync(resolve(dateDir, "manifest.json"), "utf8");

/** mjs 抽取器无类型面，在此一次性收口到服务端合同类型，后续消费不再散转 */
const manifestOf = (): AuditionManifest => extractManifest(html) as AuditionManifest;

/** 抽取产物与落盘 manifest 零漂移：抽取脚本重跑即对拍 */
describe("261007 manifest 对拍", () => {
  it("extractManifest 重跑与落盘 manifest.json 零漂移", () => {
    expect(JSON.parse(JSON.stringify(extractManifest(html)))).toEqual(JSON.parse(manifestText));
  });

  it("主矩阵 7 引擎 × 10 列 = 70 格，其中 40 可播、11 待出样、19 不适用", () => {
    const m = manifestOf();
    const cells = m.engines.flatMap((e) => e.cells);
    const byKind = (kind: string) => cells.filter((c) => c.kind === kind).length;
    expect(m.engines.map((e) => e.name)).toEqual([
      "gptsovits",
      "voxcpm",
      "indextts",
      "firered",
      "zipvoice",
      "sherpa",
      "system",
    ]);
    expect(byKind("play")).toBe(40);
    expect(byKind("await")).toBe(11);
    expect(byKind("na")).toBe(19);
  });

  it("试听裁决嗓恰 3 格：zh indextts/frieren-zh、en firered/default、ja gptsovits/frieren", () => {
    const m = manifestOf();
    const winners = m.engines.flatMap((e) =>
      e.cells.filter((c) => c.kind === "play" && c.flags.includes("winner")).map((c) => `${e.name}/${c.locale}/${c.voice}`),
    );
    expect(winners).toEqual([
      "gptsovits/ja/frieren",
      "indextts/zh/frieren-zh",
      "firered/en/default",
    ]);
  });

  it("修复重采标注 21 格（gptsovits 5、voxcpm 6、indextts 5、firered 5）", () => {
    const m = manifestOf();
    const fixByEngine = Object.fromEntries(
      m.engines.map((e) => [
        e.name,
        e.cells.filter((c) => c.flags.includes("fix")).length,
      ]),
    );
    expect(fixByEngine).toEqual({ gptsovits: 5, voxcpm: 6, indextts: 5, firered: 5, zipvoice: 0, sherpa: 0, system: 0 });
  });

  it("三语默认链与裁决一致", () => {
    const m = manifestOf();
    expect(m.verdicts).toEqual([
      expect.objectContaining({ key: "zh", engine: "indextts", voice: "frieren-zh" }),
      expect.objectContaining({ key: "en", engine: "firered", voice: "default" }),
      expect.objectContaining({ key: "ja", engine: "gptsovits", voice: "frieren" }),
    ]);
  });

  it("40 组样音文件全部在位且与格子一一对应", () => {
    const m = manifestOf();
    const playCells = m.engines.flatMap((e) =>
      e.cells.filter((c): c is Extract<typeof c, { kind: "play" }> => c.kind === "play"),
    );
    expect(playCells).toHaveLength(40);
    for (const c of playCells) {
      expect(existsSync(resolve(dateDir, c.audio)), `样音缺失: ${c.audio}`).toBe(true);
    }
  });

  it("附属证据面齐全：修复记录 5、未决项 3、性别表 9、引擎属性 7", () => {
    const m = manifestOf();
    expect(m.fixRecords).toHaveLength(5);
    expect(m.openItems).toHaveLength(3);
    expect(m.genderTable).toHaveLength(9);
    expect(m.engineProps).toHaveLength(7);
  });
});
