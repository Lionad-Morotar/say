import net from "node:net";
import { unlinkSync } from "node:fs";

/**
 * 常驻 daemon 测试套件的共享替身：进程内真 unix socket 服务端。
 * 帧协议、分块边界、EOF 时序都走真 socket 传输——fake-host 的管道替身对这些面结构性失明，
 * 传输面只能实测。daemon-session 与 binding 接线两层共用本替身。
 */

/** daemon 形态 ready 帧（engine-protocol v1 字段 + 握手版本键三元组），over 注入不符形态 */
export function readyFrame(over: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    type: "ready",
    engine: "gptsovits",
    version: "v2",
    device: "cpu",
    protocol: "2",
    weights_fingerprint: "fp-current",
    ...over,
  })}\n`;
}

export interface FakeDaemonSpec {
  /** ready 帧原文；"none" = 连上后始终不出 ready（僵死形态）；缺省合法 ready */
  ready?: string | "none";
  /** ready 前混发的引擎杂散行（库 print 进协议通道的既有形态） */
  beforeReady?: string[];
  /** 收到请求行后的行为：缺省回 audio done；"close" 立即断连（在途 EOF）；"ignore" 挂死；"error" 回错误帧 */
  onLine?: "audio" | "close" | "ignore" | "error";
  /** 按给定字节块序写帧（模拟分包在 UTF-8 多字节中间切断） */
  writeChunks?: Buffer[];
}

export interface FakeDaemon {
  connects: number;
  requests: string[];
  close(): Promise<void>;
}

export function startFakeDaemon(sockPath: string, spec: FakeDaemonSpec = {}): Promise<FakeDaemon> {
  const sockets: net.Socket[] = [];
  const requests: string[] = [];
  let connects = 0;
  try {
    unlinkSync(sockPath);
  } catch {
    /* 残file不存在属正常 */
  }
  const server = net.createServer((conn) => {
    connects += 1;
    sockets.push(conn);
    conn.setNoDelay(true);
    if (spec.writeChunks !== undefined) {
      // 分块写：逐块回调拉开间隔，loopback 不合并、退化为独立 chunk
      let i = 0;
      const step = () => {
        if (i < spec.writeChunks!.length) conn.write(spec.writeChunks![i++]!, step);
      };
      step();
    } else {
      for (const noise of spec.beforeReady ?? []) conn.write(noise);
      if (spec.ready !== "none") conn.write(spec.ready ?? readyFrame());
    }
    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let cut = buffer.indexOf("\n");
      while (cut >= 0) {
        const line = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 1);
        if (line.length > 0) {
          requests.push(line);
          if (spec.onLine === "close") {
            conn.end(); // 请求刚收到就掐连接：在途 EOF 形态
            return;
          }
          const id = (JSON.parse(line) as { id: number }).id;
          if (spec.onLine === "error") {
            conn.write(`${JSON.stringify({ type: "error", id, message: "fake 合成失败：参考音频损坏" })}\n`);
          } else if (spec.onLine !== "ignore") {
            const pcm = Buffer.alloc(4);
            pcm.writeInt16LE(16384, 0);
            pcm.writeInt16LE(-16384, 2);
            conn.write(`${JSON.stringify({ type: "audio", id, pcm: pcm.toString("base64"), sample_rate: 32000, done: true })}\n`);
          }
        }
        cut = buffer.indexOf("\n");
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(sockPath, () =>
      resolve({
        get connects() {
          return connects;
        },
        requests,
        close: () =>
          new Promise<void>((res) => {
            for (const s of sockets) s.destroy();
            server.close(() => res());
          }),
      }),
    );
    server.on("error", reject);
  });
}
