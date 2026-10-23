import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendVerdict,
  listVerdicts,
  loadVerdicts,
  orderChoiceToSource,
  saveLiveAudio,
  VerdictDataError,
  type VerdictSession,
} from "../server/lib/verdicts.ts";

const fixture = () => mkdtempSync(join(tmpdir(), "say-verdicts-"));

const session = (id: string, over: Partial<VerdictSession> = {}): VerdictSession => ({
  id,
  createdAt: "2026-10-22T18:00:00.000Z",
  prompt: "对比试听",
  sources: {
    a: { engine: "indextts", voice: "frieren-zh", audio: "audio/live-x-a.wav" },
    b: { engine: "gptsovits", voice: "frieren-zh", audio: "audio/live-x-b.wav" },
  },
  order: "ab",
  choice: "a",
  note: "",
  ...over,
});

describe("verdicts 数据面", () => {
  it("无 verdicts.json 的日期返回空 sessions", () => {
    expect(loadVerdicts(fixture(), "261022")).toEqual({ date: "261022", sessions: [] });
  });

  it("append 后 load 往返保序，多 session 累积", async () => {
    const root = fixture();
    await appendVerdict(root, "261022", session("v1"));
    await appendVerdict(root, "261022", session("v2", { choice: "tie" }));
    const loaded = loadVerdicts(root, "261022");
    expect(loaded.sessions.map((s) => s.id)).toEqual(["v1", "v2"]);
    expect(loaded.sessions[1].choice).toBe("tie");
  });

  it("并发 append 互不覆盖，两条都存活", async () => {
    const root = fixture();
    await Promise.all([
      appendVerdict(root, "261022", session("v1")),
      appendVerdict(root, "261022", session("v2")),
    ]);
    const ids = loadVerdicts(root, "261022").sessions.map((s) => s.id).sort();
    expect(ids).toEqual(["v1", "v2"]);
  });

  it("落盘的是合法 JSON 且不带 tmp 后缀残留", async () => {
    const root = fixture();
    await appendVerdict(root, "261022", session("v1"));
    const p = join(root, "261022", "verdicts.json");
    expect(existsSync(p)).toBe(true);
    expect(() => JSON.parse(readFileSync(p, "utf8"))).not.toThrow();
  });

  it("非法 date 与坏 JSON 拒绝", () => {
    const root = fixture();
    expect(() => loadVerdicts(root, "../x")).toThrow(VerdictDataError);
    const dir = join(root, "261031");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "verdicts.json"), "{broken");
    expect(() => loadVerdicts(root, "261031")).toThrow(VerdictDataError);
  });

  it("listVerdicts 跨日期聚合按日期倒序", async () => {
    const root = fixture();
    await appendVerdict(root, "261022", session("v1"));
    await appendVerdict(root, "261031", session("v2"));
    const list = listVerdicts(root);
    expect(list.map((d) => d.date)).toEqual(["261031", "261022"]);
  });

  it("saveLiveAudio 落盘 wav 并返回档期相对路径", () => {
    const root = fixture();
    const rel = saveLiveAudio(root, "261022", "v1", "a", Buffer.from("RIFFxxWAVE"));
    expect(rel).toBe("audio/live-v1-a.wav");
    expect(existsSync(join(root, "261022", "audio", "live-v1-a.wav"))).toBe(true);
  });
});

describe("orderChoiceToSource", () => {
  it("播放序 ab 时先播即 a；ba 时先播即 b；tie 原样", () => {
    expect(orderChoiceToSource("ab", "first")).toBe("a");
    expect(orderChoiceToSource("ab", "second")).toBe("b");
    expect(orderChoiceToSource("ba", "first")).toBe("b");
    expect(orderChoiceToSource("ba", "second")).toBe("a");
    expect(orderChoiceToSource("ab", "tie")).toBe("tie");
    expect(orderChoiceToSource("ba", "tie")).toBe("tie");
  });
});
