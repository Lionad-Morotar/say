/**
 * 16-bit PCM 单声道 WAV 编码。自研而非复用绑定的 writeWave：
 * 单测不该为了断言容器格式而加载 native 插件，且分块合成需要在样本层拼接后再统一封容器。
 */

const HEADER_BYTES = 44;
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;
/** 对称缩放：正负端点都是 32767，避免 -32768 这个只有负向才有的端点引入直流偏置 */
const FULL_SCALE = 32767;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * (BITS_PER_SAMPLE / 8);
  const bytes = new Uint8Array(HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);
  const byteRate = sampleRate * CHANNELS * (BITS_PER_SAMPLE / 8);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, CHANNELS * (BITS_PER_SAMPLE / 8), true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i] ?? 0;
    // 钳制而非回绕：越界样本若按位截断会翻相，听感是爆音而不是削顶
    const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
    view.setInt16(HEADER_BYTES + i * 2, Math.round(clamped * FULL_SCALE), true);
  }
  return bytes;
}

export function concatSamples(parts: readonly Float32Array[]): Float32Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
