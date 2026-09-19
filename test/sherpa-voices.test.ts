import { describe, expect, it } from "vitest";
import {
  KOKORO_VOICE_COUNT,
  KOKORO_VOICES,
  MATCHA_VOICES,
  SHERPA_VOICE_LANGS,
  kokoroSidOf,
  sherpaVoiceLang,
} from "../src/engines/sherpa-voices.ts";

describe("kokoro sid 表：voices.bin 只有嵌入向量没有名字，名字必须由内嵌表提供", () => {
  it("条目数与绑定运行时 numSpeakers 一致", () => {
    expect(KOKORO_VOICES).toHaveLength(KOKORO_VOICE_COUNT);
  });

  it("数组下标即 sid，官方文档的四组前缀区间逐点对齐", () => {
    expect(KOKORO_VOICES[0]).toBe("af_maple");
    expect(KOKORO_VOICES[1]).toBe("af_sol");
    expect(KOKORO_VOICES[2]).toBe("bf_vale");
    expect(KOKORO_VOICES[3]).toBe("zf_001");
    expect(KOKORO_VOICES[57]).toBe("zf_099");
    expect(KOKORO_VOICES[58]).toBe("zm_009");
    expect(KOKORO_VOICES[102]).toBe("zm_100");
  });

  it("sid 连续无空洞、名字无重复，表的形状因此可信", () => {
    expect(new Set(KOKORO_VOICES).size).toBe(KOKORO_VOICES.length);
    expect(KOKORO_VOICES.every((name) => name.length > 0)).toBe(true);
  });

  it("前缀计数与官方文档的前缀表一致（af 2 / bf 1 / zf 55 / zm 45）", () => {
    const counts: Record<string, number> = {};
    for (const name of KOKORO_VOICES) {
      const prefix = name.slice(0, 2);
      counts[prefix] = (counts[prefix] ?? 0) + 1;
    }
    expect(counts).toEqual({ af: 2, bf: 1, zf: 55, zm: 45 });
  });

  it("每个前缀占据连续 sid 区间，区间边界即官方文档给出的范围", () => {
    const rangeOf = (prefix: string) => {
      const ids = KOKORO_VOICES.map((name, sid) => ({ name, sid }))
        .filter((entry) => entry.name.startsWith(prefix))
        .map((entry) => entry.sid);
      return { first: ids[0], last: ids[ids.length - 1], contiguous: ids.every((v, i) => v === ids[0]! + i) };
    };
    expect(rangeOf("af")).toEqual({ first: 0, last: 1, contiguous: true });
    expect(rangeOf("bf")).toEqual({ first: 2, last: 2, contiguous: true });
    expect(rangeOf("zf")).toEqual({ first: 3, last: 57, contiguous: true });
    expect(rangeOf("zm")).toEqual({ first: 58, last: 102, contiguous: true });
  });

  it("名字形状只有两类：拉丁嗓用字母后缀，中文嗓用三位编号", () => {
    for (const name of KOKORO_VOICES) {
      expect(name).toMatch(/^(?:(?:af|bf)_[a-z]+|(?:zf|zm)_\d{3})$/);
    }
  });
});

describe("kokoroSidOf：名字到 sid 的反查", () => {
  it("表内名字返回其下标", () => {
    expect(kokoroSidOf("af_maple")).toBe(0);
    expect(kokoroSidOf("bf_vale")).toBe(2);
    expect(kokoroSidOf("zf_001")).toBe(3);
    expect(kokoroSidOf("zm_100")).toBe(102);
  });

  it("表外名字返回 null，由上层决定改走系统嗓而不是静默落到 sid 0", () => {
    expect(kokoroSidOf("Tingting")).toBeNull();
    expect(kokoroSidOf("")).toBeNull();
    expect(kokoroSidOf("af_maple ")).toBeNull();
  });
});

describe("sherpa 音色登记面", () => {
  it("matcha 单嗓登记，别名与规范名指向同一 sid", () => {
    const names = MATCHA_VOICES.map((voice) => voice.name);
    expect(names).toContain("zh_baker");
    expect(names).toContain("baker");
    expect(MATCHA_VOICES.every((voice) => voice.sid === 0)).toBe(true);
  });

  it("kokoro 与 matcha 的音色名不冲突，同名会导致路由二义", () => {
    const matchaNames = new Set(MATCHA_VOICES.map((voice) => voice.name));
    expect(KOKORO_VOICES.some((name) => matchaNames.has(name))).toBe(false);
  });

  it("语言倾向按前缀判定：拉丁嗓 en、中文嗓 zh、matcha zh", () => {
    expect(sherpaVoiceLang("af_maple")).toBe("en");
    expect(sherpaVoiceLang("bf_vale")).toBe("en");
    expect(sherpaVoiceLang("zf_001")).toBe("zh");
    expect(sherpaVoiceLang("zm_100")).toBe("zh");
    expect(sherpaVoiceLang("zh_baker")).toBe("zh");
    expect(sherpaVoiceLang("baker")).toBe("zh");
  });

  it("未登记音色没有语言倾向，交给系统嗓自己解释", () => {
    expect(sherpaVoiceLang("Tingting")).toBeNull();
    expect(SHERPA_VOICE_LANGS.has("Tingting")).toBe(false);
  });

  it("语言表覆盖全部登记音色，列举时不会出现 undefined 语言", () => {
    for (const name of [...KOKORO_VOICES, ...MATCHA_VOICES.map((voice) => voice.name)]) {
      expect(SHERPA_VOICE_LANGS.get(name), name).toMatch(/^(en|zh)$/);
    }
  });
});
