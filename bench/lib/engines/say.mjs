// 系统 say 对照通道：Eddy(en) / Tingting(zh, mixed)，与神经 TTS 同文本同口径对跑。
// 无模型加载，cold≈hot 属预期——对照面正是「神经 TTS 相对系统 say 的延迟差」。
import { existsSync, statSync } from "node:fs";
import { TEXTS } from "../config.mjs";
import { runCmd } from "../exec.mjs";

const VOICE_BY_LANG = { en: "Eddy", zh: "Tingting", mixed: "Tingting" };

export const sayAdapter = {
  engine: "system-say",
  channel: "spawn",
  paired: false,
  async available() {
    return existsSync("/usr/bin/say")
      ? { ok: true }
      : { ok: false, reason: "/usr/bin/say 不存在" };
  },
  /** @returns {Promise<{rows: Array}>} 单次 spawn 产出一行测量（cold/hot 由 runner 按调用序标记） */
  async measure({ textid, text, rawPath }) {
    const voice = VOICE_BY_LANG[TEXTS[textid].lang];
    const outFile = `${rawPath}.aiff`;
    const cmd = ["/usr/bin/say", "-v", voice, "-o", outFile, text];
    const r = await runCmd(cmd, { timeoutMs: 120_000 });
    return {
      rows: [
        {
          model: `say-${voice}`,
          exit: r.exit,
          durationMs: r.durationMs,
          started: r.started,
          ended: r.ended,
          cmdStr: r.cmdStr,
          outFile,
          outBytes: existsSync(outFile) ? statSync(outFile).size : 0,
          stderrTail: r.stderrTail,
        },
      ],
    };
  },
};
