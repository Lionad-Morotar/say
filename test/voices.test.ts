import { describe, expect, it } from "vitest";
import { resolveCharacterVoice, splitVoiceName, transcriptOf } from "../src/voices.ts";
import { EngineError } from "../src/errors.ts";
import { createFakeHost } from "./fake-host.ts";

const VOICES = "/data/voices";

const LUCY_META = JSON.stringify({
  character: "lucy",
  language: "en",
  transcription: { source: "官方字幕" },
});

const FRIEREN_META = JSON.stringify({
  character: "frieren",
  language: "ja",
  transcription: { source: "whisper 转写" },
  variants: {
    en: { language: "en" },
    zh: { language: "zh" },
  },
});

function makeHost(files: Record<string, string> = {}) {
  return createFakeHost({ env: { HOME: "/h" }, files: { [`${VOICES}/lucy/meta.json`]: LUCY_META, [`${VOICES}/frieren/meta.json`]: FRIEREN_META, ...files } });
}

describe("splitVoiceName：音色名到角色与语言变体的拆解", () => {
  it("目录直名即无变体的角色音色", () => {
    expect(splitVoiceName(makeHost().host, VOICES, "lucy")).toEqual({ character: "lucy", variant: null });
  });

  it("变体名按连字符拆到角色，以角色目录在盘为准", () => {
    expect(splitVoiceName(makeHost().host, VOICES, "frieren-en")).toEqual({ character: "frieren", variant: "en" });
  });

  it("不存在的角色名不认领，返回 null 而不是构造指向空目录的引用", () => {
    expect(splitVoiceName(makeHost().host, VOICES, "nosuch")).toBeNull();
    expect(splitVoiceName(makeHost().host, VOICES, "nosuch-en")).toBeNull();
    expect(splitVoiceName(makeHost().host, VOICES, "nosuch-en")).toBeNull();
  });
});

describe("transcriptOf：参考转写剥离溯源注释", () => {
  it("剥掉 # 开头的溯源注释行，正文逐字保留", () => {
    const raw = "That's through your personal link.\n\n# 转写来源: Netflix 官方字幕（《Like A Boy》）\n";
    expect(transcriptOf(raw)).toBe("That's through your personal link.");
  });

  it("无注释的纯正文原样返回（首尾空白归一）", () => {
    expect(transcriptOf("  hello world  \n")).toBe("hello world");
  });

  it("剥离后为空即报错：注释不能冒充参考文本", () => {
    expect(() => transcriptOf("# only comments\n")).toThrow(EngineError);
  });
});

describe("resolveCharacterVoice：角色资产到引擎克隆参数", () => {
  it("主资产解析出 ref.wav 与 ref.txt 的绝对路径", async () => {
    const fake = makeHost({
      [`${VOICES}/lucy/ref.wav`]: "",
      [`${VOICES}/lucy/ref.txt`]: "",
    });
    const spec = await resolveCharacterVoice(fake.host, VOICES, "lucy");
    expect(spec).toEqual({ character: "lucy", variant: null, audioPath: `${VOICES}/lucy/ref.wav`, textPath: `${VOICES}/lucy/ref.txt` });
  });

  it("变体解析到 ref-<variant> 文件对", async () => {
    const fake = makeHost({
      [`${VOICES}/frieren/ref-en.wav`]: "",
      [`${VOICES}/frieren/ref-en.txt`]: "",
    });
    const spec = await resolveCharacterVoice(fake.host, VOICES, "frieren-en");
    expect(spec).toMatchObject({ character: "frieren", variant: "en", audioPath: `${VOICES}/frieren/ref-en.wav` });
  });

  it("目录在盘但 meta.json 缺失时报引擎错误，指向 meta 而非笼统失败", async () => {
    const fake = createFakeHost({
      env: {},
      files: {
        [`${VOICES}/lucy/ref.wav`]: "",
        [`${VOICES}/lucy/ref.txt`]: "",
        [`${VOICES}/frieren/meta.json`]: FRIEREN_META,
      },
    });
    await expect(resolveCharacterVoice(fake.host, VOICES, "lucy")).rejects.toThrow(/meta\.json/);
  });

  it("meta.json 不是合法 JSON 时按资产损坏报错", async () => {
    const fake = createFakeHost({ env: {}, files: { [`${VOICES}/lucy/meta.json`]: "{oops" } });
    await expect(resolveCharacterVoice(fake.host, VOICES, "lucy")).rejects.toBeInstanceOf(EngineError);
  });

  it("ref.wav 或 ref.txt 缺失时一次列全缺失项，交给回退层报一行原因", async () => {
    const fake = makeHost({});
    const error = await resolveCharacterVoice(fake.host, VOICES, "lucy").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EngineError);
    if (error instanceof EngineError) {
      expect(error.message).toContain("ref.wav");
      expect(error.message).toContain("ref.txt");
    }
  });

  it("meta 未声明该变体时报错点名变体，而不是静默落回主资产", async () => {
    const fake = makeHost({ [`${VOICES}/frieren/ref-de.wav`]: "", [`${VOICES}/frieren/ref-de.txt`]: "" });
    await expect(resolveCharacterVoice(fake.host, VOICES, "frieren-de")).rejects.toThrow(/de/);
  });
});