// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import VoiceMatrix from "../app/components/VoiceMatrix.vue";
import MatrixPlayer from "../app/components/MatrixPlayer.vue";
import type { AuditionManifest, PlayCell } from "../server/lib/auditions.ts";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(resolve(here, "../../../docs/audition/261007/manifest.json"), "utf8"),
) as AuditionManifest;

describe("VoiceMatrix", () => {
  it("渲染 70 格：40 可播按钮、11 待出样、19 不适用", () => {
    const w = mount(VoiceMatrix, { props: { engines: manifest.engines } });
    expect(w.findAll("td[data-testid^='cell-']")).toHaveLength(70);
    expect(w.findAll("td[data-testid^='cell-'] button")).toHaveLength(40);
    expect(w.findAll("td.await")).toHaveLength(11);
    expect(w.findAll("td.na")).toHaveLength(19);
  });

  it("裁决/修复/ja 标注逐类落位", () => {
    const w = mount(VoiceMatrix, { props: { engines: manifest.engines } });
    expect(w.findAll(".winner")).toHaveLength(3);
    expect(w.find("[data-testid='cell-indextts-zh-frieren-zh']").classes()).toContain("winner");
    expect(w.findAll(".fix")).toHaveLength(21);
    expect(w.findAll(".ja")).toHaveLength(8);
  });

  it("activeKey 命中的格子带 playing 类，其余不带", () => {
    const w = mount(VoiceMatrix, {
      props: { engines: manifest.engines, activeKey: "cell-gptsovits-ja-frieren" },
    });
    expect(w.find("[data-testid='cell-gptsovits-ja-frieren'] button").classes()).toContain("playing");
    expect(w.find("[data-testid='cell-indextts-zh-frieren-zh'] button").classes()).not.toContain("playing");
  });

  it("点击可播格 emit play 并携带格子坐标与音频引用", () => {
    const w = mount(VoiceMatrix, { props: { engines: manifest.engines } });
    w.find("[data-testid='cell-gptsovits-ja-frieren'] button").trigger("click");
    const emitted = w.emitted<PlayCell[]>("play");
    expect(emitted).toHaveLength(1);
    expect(emitted?.[0][0]).toMatchObject({
      engine: "gptsovits",
      locale: "ja",
      voice: "frieren",
      audio: "audio/gptsovits-ja-frieren.wav",
    });
  });
});

describe("MatrixPlayer", () => {
  it("无格子时给出占位提示", () => {
    const w = mount(MatrixPlayer, { props: { cell: null, date: "261007" } });
    expect(w.find("[data-testid='player-label']").text()).toContain("点击矩阵");
  });

  it("有格子时 audio src 指向档期音频路由并显示文件名", () => {
    const w = mount(MatrixPlayer, {
      props: {
        cell: {
          engine: "gptsovits",
          locale: "ja",
          voice: "frieren",
          kind: "play",
          audio: "audio/gptsovits-ja-frieren.wav",
          label: "frieren",
          flags: [],
        },
        date: "261007",
      },
    });
    expect(w.find("audio").attributes("src")).toBe(
      "/api/auditions/261007/audio/gptsovits-ja-frieren.wav",
    );
    expect(w.find("[data-testid='player-label']").text()).toContain("gptsovits-ja-frieren.wav");
  });
});
