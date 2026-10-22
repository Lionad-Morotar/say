import { existsSync, mkdtempSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AuditionDataError,
  listAuditions,
  readManifest,
  resolveAudioPath,
} from "../server/lib/auditions.ts";

const here = dirname(fileURLToPath(import.meta.url));
const auditionsRoot = resolve(here, "../../../docs/audition");

describe("auditions 数据服务", () => {
  it("扫描出 261007 档期并带裁决三语", () => {
    const list = listAuditions(auditionsRoot);
    const dates = list.map((a) => a.date);
    expect(dates).toContain("261007");
    const entry = list.find((a) => a.date === "261007");
    expect(entry?.verdicts.map((v) => `${v.key}:${v.engine}/${v.voice}`)).toEqual([
      "zh:indextts/frieren-zh",
      "en:firered/default",
      "ja:gptsovits/frieren",
    ]);
  });

  it("单个坏 manifest 档期被隔离，健康档期照常列出", () => {
    const fixture = mkdtempSync(join(tmpdir(), "say-auditions-"));
    cpSync(join(auditionsRoot, "261007"), join(fixture, "261007"), { recursive: true });
    mkdirSync(join(fixture, "269901"));
    writeFileSync(join(fixture, "269901", "manifest.json"), '{"date": "269901",');
    const list = listAuditions(fixture);
    expect(list.map((a) => a.date)).toEqual(["261007"]);
  });

  it("合法 JSON 但形状不对的 manifest 拒绝，不裸吐给前端", () => {
    const fixture = mkdtempSync(join(tmpdir(), "say-auditions-"));
    mkdirSync(join(fixture, "269902"));
    writeFileSync(join(fixture, "269902", "manifest.json"), "[]");
    expect(() => readManifest(fixture, "269902")).toThrow(AuditionDataError);
  });

  it("非法 date 目录名拒绝（防路径穿越）", () => {
    expect(() => readManifest(auditionsRoot, "../audition")).toThrow(AuditionDataError);
    expect(() => readManifest(auditionsRoot, "abc")).toThrow(AuditionDataError);
  });

  it("音频路径：合法 wav 放行且存在，穿越与非法名拒绝", () => {
    const p = resolveAudioPath(auditionsRoot, "261007", "gptsovits-ja-frieren.wav");
    expect(existsSync(p)).toBe(true);
    expect(() => resolveAudioPath(auditionsRoot, "261007", "../engine-v2-voice-matrix.html")).toThrow(AuditionDataError);
    expect(() => resolveAudioPath(auditionsRoot, "261007", "a/b.wav")).toThrow(AuditionDataError);
    expect(() => resolveAudioPath(auditionsRoot, "261007", "x.mp3")).toThrow(AuditionDataError);
    expect(() => resolveAudioPath(auditionsRoot, "261007", "missing.wav")).toThrow(AuditionDataError);
  });
});
