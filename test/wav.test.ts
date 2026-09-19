import { describe, expect, it } from "vitest";
import { encodeWav } from "../src/wav.ts";

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function pcmOf(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: number[] = [];
  for (let i = 44; i < bytes.byteLength; i += 2) out.push(view.getInt16(i, true));
  return out;
}

describe("encodeWav：16-bit PCM 单声道容器", () => {
  it("头 44 字节按 RIFF/WAVE 布局写入，长度字段自洽", () => {
    const bytes = encodeWav(new Float32Array([0, 0.5, -0.5, 1]), 24000);
    expect(bytes.byteLength).toBe(44 + 8);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(ascii(bytes, 0, 4)).toBe("RIFF");
    expect(u32(view, 4)).toBe(36 + 8);
    expect(ascii(bytes, 8, 4)).toBe("WAVE");
    expect(ascii(bytes, 12, 4)).toBe("fmt ");
    expect(u32(view, 16)).toBe(16);
    expect(u16(view, 20)).toBe(1);
    expect(u16(view, 22)).toBe(1);
    expect(u32(view, 24)).toBe(24000);
    expect(u32(view, 28)).toBe(48000);
    expect(u16(view, 32)).toBe(2);
    expect(u16(view, 34)).toBe(16);
    expect(ascii(bytes, 36, 4)).toBe("data");
    expect(u32(view, 40)).toBe(8);
  });

  it("浮点样本按 32767 对称缩放为 Int16，不引入 -32768 的不对称端点", () => {
    expect(pcmOf(encodeWav(new Float32Array([0, 1, -1, 0.5]), 24000))).toEqual([
      0, 32767, -32767, 16384,
    ]);
  });

  it("超出 [-1, 1] 的样本被钳制而非回绕", () => {
    expect(pcmOf(encodeWav(new Float32Array([2, -2, 1.5]), 24000))).toEqual([32767, -32767, 32767]);
  });

  it("采样率原样写入，22050 与 24000 各自的 byteRate 随之变化", () => {
    const a = new DataView(encodeWav(new Float32Array([0]), 22050).buffer);
    const b = new DataView(encodeWav(new Float32Array([0]), 24000).buffer);
    expect(u32(a, 24)).toBe(22050);
    expect(u32(a, 28)).toBe(44100);
    expect(u32(b, 24)).toBe(24000);
    expect(u32(b, 28)).toBe(48000);
  });

  it("空样本产出仅含头的合法空 wav，而不是抛错", () => {
    const bytes = encodeWav(new Float32Array([]), 24000);
    expect(bytes.byteLength).toBe(44);
    expect(u32(new DataView(bytes.buffer), 40)).toBe(0);
  });

  it("拼接两段样本与一次性编码等长样本结果一致，分块合并因此可直接在样本层拼接", () => {
    const left = new Float32Array([0.25, -0.25]);
    const right = new Float32Array([0.75, -0.75]);
    const merged = new Float32Array([...left, ...right]);
    expect(pcmOf(encodeWav(merged, 24000))).toEqual(pcmOf(encodeWav(concat(left, right), 24000)));
  });
});

function concat(...parts: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
