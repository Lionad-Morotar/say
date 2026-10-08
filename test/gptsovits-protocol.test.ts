import { describe, expect, it } from "vitest";
import {
  decodePcm,
  encodeRequest,
  parseLine,
  type GptsovitsRequest,
} from "../src/engines/gptsovits-protocol.ts";

describe("encodeRequest", () => {
  it("合成请求序列化为一行 JSON，字段与 api_v2 /tts 一比一同名", () => {
    const req: GptsovitsRequest = {
      id: 7,
      text: "你好世界",
      refAudioPath: "/lab/ref.wav",
      promptText: "参考转写正文",
      promptLang: "zh",
      textLang: "auto",
      speedFactor: 1.25,
    };
    const line = encodeRequest(req);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.split("\n")).toHaveLength(2);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toEqual({
      type: "synthesize",
      id: 7,
      text: "你好世界",
      ref_audio_path: "/lab/ref.wav",
      prompt_text: "参考转写正文",
      prompt_lang: "zh",
      text_lang: "auto",
      speed_factor: 1.25,
    });
  });

  it("caller_pid 是 daemon 形态的可选归因键：给了才写，per-call 不给就不出现在帧里", () => {
    const base: Omit<GptsovitsRequest, "id"> = {
      text: "hi",
      refAudioPath: "/r.wav",
      promptText: "",
      promptLang: "auto",
      textLang: "auto",
      speedFactor: 1,
    };
    const withPid = JSON.parse(encodeRequest({ ...base, id: 1, callerPid: 4242 })) as Record<string, unknown>;
    expect(withPid.caller_pid).toBe(4242);
    const withoutPid = JSON.parse(encodeRequest({ ...base, id: 1 })) as Record<string, unknown>;
    expect("caller_pid" in withoutPid).toBe(false);
  });

  it("文本含换行时整体仍是一帧：换行被 JSON 转义，不产生协议串扰", () => {
    const line = encodeRequest({
      id: 1,
      text: "第一行\n第二行",
      refAudioPath: "/r.wav",
      promptText: "p",
      promptLang: "zh",
      textLang: "zh",
      speedFactor: 1,
    });
    const frames = line.split("\n");
    expect(frames).toHaveLength(2);
    expect((JSON.parse(frames[0]!) as { text: string }).text).toBe("第一行\n第二行");
  });
});

describe("parseLine", () => {
  it("ready 消息解析出引擎/版本/设备", () => {
    const msg = parseLine('{"type":"ready","engine":"gptsovits","version":"v2","device":"cpu"}');
    expect(msg).toEqual({
      type: "ready",
      engine: "gptsovits",
      version: "v2",
      device: "cpu",
    });
  });

  it("audio 消息保留 base64 与采样率的原始形态，done 缺省视为未完", () => {
    const msg = parseLine('{"type":"audio","id":3,"pcm":"AQID","sample_rate":32000}');
    expect(msg).toEqual({ type: "audio", id: 3, pcm: "AQID", sampleRate: 32000, done: false });
  });

  it("audio 消息 done=true 标记流式尾块", () => {
    const msg = parseLine('{"type":"audio","id":3,"pcm":"","sample_rate":32000,"done":true}');
    expect(msg).toEqual({ type: "audio", id: 3, pcm: "", sampleRate: 32000, done: true });
  });

  it("error 消息带请求 id 与原因", () => {
    const msg = parseLine('{"type":"error","id":9,"message":"ref_audio_path 不存在"}');
    expect(msg).toEqual({ type: "error", id: 9, message: "ref_audio_path 不存在" });
  });

  it("fatal 消息无 id（加载期失败，尚无请求可归属）", () => {
    const msg = parseLine('{"type":"fatal","message":"权重缺失"}');
    expect(msg).toEqual({ type: "fatal", message: "权重缺失" });
  });

  it("未知类型与坏 JSON 返回 null 由调用方按垃圾行丢弃", () => {
    expect(parseLine('{"type":"teleport"}')).toBeNull();
    expect(parseLine("not json at all")).toBeNull();
    expect(parseLine("")).toBeNull();
    expect(parseLine("   ")).toBeNull();
  });
});

describe("decodePcm", () => {
  it("int16 LE 字节流转 Float32 归一化样本（[-1, 1)）", () => {
    // 0x0000=0, 0x0100=256, 0xFFFF=-1, 0x8000=-32768
    const base64 = Buffer.from([0x00, 0x00, 0x00, 0x01, 0xff, 0xff, 0x00, 0x80]).toString("base64");
    const samples = decodePcm(base64);
    expect(samples).toBeInstanceOf(Float32Array);
    expect(samples.length).toBe(4);
    expect(samples[0]).toBe(0);
    expect(samples[1]).toBeCloseTo(256 / 32768, 6);
    expect(samples[2]).toBeCloseTo(-1 / 32768, 6);
    expect(samples[3]).toBe(-1);
  });

  it("空 base64 得到空样本数组（静音块不炸协议层，能量校验归合成层）", () => {
    const samples = decodePcm("");
    expect(samples.length).toBe(0);
  });
});
