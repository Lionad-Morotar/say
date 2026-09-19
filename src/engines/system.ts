import { EngineError } from "../errors.ts";
import { defineExecutor } from "../executor.ts";
import { SYSTEM_SAY_BIN, type Host } from "../host.ts";
import type { Availability, EngineAdapter, VoiceInfo } from "../types.ts";

/** 容器格式必须显式声明：实测 `say -o x.wav` 直接失败（Opening output file failed: fmt?），扩展名并不触发推断 */
const WAVE_FORMAT_ARGS = ["--file-format=WAVE", "--data-format=LEI16"] as const;

/**
 * 音色名可以带空格与本地化括号（如 `Eddy (德语（德国）)`），按空白切首列会切错，
 * 因此以 locale 令牌为锚点反推名字边界；无 locale 或无样例注释的行按不可识别跳过。
 */
const VOICE_LINE = /^(.+?)\s+([A-Za-z]{2}_[A-Za-z]{2})\s*#/;

function langOf(locale: string): VoiceInfo["lang"] {
  if (locale.startsWith("en_")) return "en";
  if (locale.startsWith("zh_")) return "zh";
  return "multi";
}

export function parseSayVoiceList(stdout: string): VoiceInfo[] {
  const voices: VoiceInfo[] = [];
  for (const line of stdout.split("\n")) {
    const match = VOICE_LINE.exec(line);
    if (match === null) continue;
    const name = match[1]?.trim();
    const locale = match[2];
    if (name === undefined || name.length === 0 || locale === undefined) continue;
    voices.push({ name, engine: "system", lang: langOf(locale) });
  }
  return voices;
}

/**
 * 系统 say 适配：既是 `engine = "system"` 的正常通道，也是神经引擎失败时的回退目标。
 * 走子进程执行器——它没有可进程内调用的绑定，拓扑上只能是 subprocess。
 */
export function createSystemEngine(host: Host, sayBin: string = SYSTEM_SAY_BIN): EngineAdapter {
  const executor = defineExecutor("subprocess", async (task) => {
    const args: string[] = [];
    if (task.voice !== null) args.push("-v", task.voice);
    args.push("-r", String(task.rateWpm));
    if (task.output !== null) args.push("-o", task.output, ...WAVE_FORMAT_ARGS);
    // 正文走 stdin 而非 argv：长文本会撞 ARG_MAX，顺带免掉一层元字符转义面
    args.push("-f", "-");

    const outcome = await host.spawn(sayBin, args, { stdin: task.text });
    if (outcome.exitCode !== 0) {
      const cause =
        outcome.signal !== null
          ? `被信号 ${outcome.signal} 终止`
          : `退出码 ${outcome.exitCode === null ? "未知" : outcome.exitCode}`;
      const detail = outcome.stderr.trim();
      throw new EngineError(`系统 say 合成失败（${cause}）${detail.length > 0 ? `：${detail}` : ""}`);
    }
    return task.output !== null ? { type: "file", path: task.output } : { type: "device" };
  });

  return {
    name: "system",
    // say 自己写盘或直推声卡，编排层拿不到裸样本，块间无从拼接；
    // 它也没有单次长度上限，分块只会平白多出边界停顿
    chunkable: false,
    // 系统嗓的音色是开放集合（且未知音色名会被 macOS say 静默忽略而非报错），
    // 可用性只取决于二进制在不在盘，与音色无关
    async isAvailable(_voice: string | null): Promise<Availability> {
      return host.fileExists(sayBin) ? { ok: true } : { ok: false, reason: `${sayBin} 不存在` };
    },
    async listVoices(): Promise<VoiceInfo[]> {
      const outcome = await host.spawn(sayBin, ["-v", "?"], {});
      return outcome.exitCode === 0 ? parseSayVoiceList(outcome.stdout) : [];
    },
    speak: (text, opts) =>
      executor.synthesize({ text, voice: opts.voice, rateWpm: opts.rateWpm, output: opts.output }),
  };
}
