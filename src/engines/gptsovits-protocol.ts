/**
 * GPT-SoVITS 子进程协议（引擎层 v2 协议钉版，S3）的 Node 侧编解码。
 * 帧格式与三消息型语义见 docs/engine-protocol.md——本文件是契约的 TS 执行面，
 * Python shim（scripts/shims/gptsovits-shim.py）是同一契约的另一侧，改帧格式两处同改。
 */

/** 合成请求：字段名与 GPT-SoVITS api_v2 /tts 一比一同名（snake_case），排障时两形态可直接对照 */
export interface GptsovitsRequest {
  /** 请求关联 id：响应经它配对，shim 侧不解释只回传 */
  id: number;
  text: string;
  refAudioPath: string;
  promptText: string;
  /** 参考音频的语言（api_v2 prompt_lang 枚举） */
  promptLang: string;
  /** 合成文本的语言，"auto" 交给引擎侧检测 */
  textLang: string;
  speedFactor: number;
  /** 引擎侧自然语言控制指令（S4 起，VoxCPM voice creation 消费）；缺席即无指令，shim 侧按需忽略 */
  control?: string;
  /**
   * 时长倍率（S5 起，IndexTTS 消费）：与 speedFactor 语义互为倒数（值越大音频越长、语速越慢），
   * 语义反向故独立字段不复用；缺席 = 引擎默认 1.0
   */
  durationFactor?: number;
  /** 情感强度预留（S5 起，IndexTTS 语义域 0-1）：需与引擎侧情感参考配对才生效，一期 adapter 不发送 */
  emoAlpha?: number;
  /**
   * 调用方进程 pid（daemon 形态注入）：id 是调用方进程内计数器，
   * 多 CLI 进程并发共用一个 daemon 时请求号各自起排必撞车，daemon.log 完成行无从归因。
   * per-call 形态一进程一会话无此歧义不必带；shim 字段读取全走 .get 容缺面，旧 daemon 忽略陌生键。
   */
  callerPid?: number;
}

/** 就绪消息：模型加载完成的握手信号（冷启动 ~12s 后到达） */
export interface GptsovitsReady {
  type: "ready";
  engine: string;
  version: string;
  device: string;
}

/** 音频块消息：int16 LE PCM 的 base64；流式为多块序列，done=true 标尾 */
export interface GptsovitsAudio {
  type: "audio";
  id: number;
  pcm: string;
  sampleRate: number;
  done: boolean;
}

/** 请求级错误：合成失败但进程存活，可继续下一请求 */
export interface GptsovitsError {
  type: "error";
  id: number;
  message: string;
}

/** 致命错误：加载期失败，进程将退出，无请求可归属 */
export interface GptsovitsFatal {
  type: "fatal";
  message: string;
}

export type GptsovitsMessage = GptsovitsReady | GptsovitsAudio | GptsovitsError | GptsovitsFatal;

/** 协议帧：一行一个 JSON 对象 + \n。文本内换行由 JSON 转义承担，天然不成帧 */
export function encodeRequest(req: GptsovitsRequest): string {
  return `${JSON.stringify({
    type: "synthesize",
    id: req.id,
    text: req.text,
    ref_audio_path: req.refAudioPath,
    prompt_text: req.promptText,
    prompt_lang: req.promptLang,
    text_lang: req.textLang,
    speed_factor: req.speedFactor,
    ...(req.control !== undefined ? { control: req.control } : {}),
    ...(req.durationFactor !== undefined ? { duration_factor: req.durationFactor } : {}),
    ...(req.emoAlpha !== undefined ? { emo_alpha: req.emoAlpha } : {}),
    ...(req.callerPid !== undefined ? { caller_pid: req.callerPid } : {}),
  })}\n`;
}

/**
 * 单行 → 消息。返回 null 的三种形态：空行、坏 JSON、未知 type——
 * 垃圾行（引擎库向 stdout 的杂散打印）按丢弃处理由调用方计数，
 * 不在这里抛错：一行杂讯不该毒掉整条常驻进程的解析面。
 */
export function parseLine(line: string): GptsovitsMessage | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const msg = raw as Record<string, unknown>;
  switch (msg.type) {
    case "ready":
      return {
        type: "ready",
        engine: typeof msg.engine === "string" ? msg.engine : "",
        version: typeof msg.version === "string" ? msg.version : "",
        device: typeof msg.device === "string" ? msg.device : "",
      };
    case "audio":
      if (typeof msg.pcm !== "string" || typeof msg.id !== "number" || typeof msg.sample_rate !== "number") {
        return null;
      }
      return { type: "audio", id: msg.id, pcm: msg.pcm, sampleRate: msg.sample_rate, done: msg.done === true };
    case "error":
      if (typeof msg.id !== "number" || typeof msg.message !== "string") return null;
      return { type: "error", id: msg.id, message: msg.message };
    case "fatal":
      if (typeof msg.message !== "string") return null;
      return { type: "fatal", message: msg.message };
    default:
      return null;
  }
}

/**
 * base64(int16 LE) → 归一化 Float32 样本。除以 32768 落 [-1, 1)，
 * 与 wav.ts encodeWav 的正向编码（乘 32767 取整）方向一致，量化误差不叠加。
 */
export function decodePcm(base64: string): Float32Array {
  if (base64.length === 0) return new Float32Array(0);
  const bytes = Buffer.from(base64, "base64");
  const count = Math.floor(bytes.length / 2);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    samples[i] = bytes.readInt16LE(i * 2) / 32768;
  }
  return samples;
}
