/**
 * argv → 请求形态。解析层只做识别，不做取舍：
 * `-f` 与位置参数并存时谁胜、未登记音色怎么路由，都留给编排层裁决，
 * 这样解析结果始终是 argv 的忠实映射，可独立断言。
 */

export type CliRequest =
  | {
      kind: "speak";
      texts: string[];
      /** `-f` 的值；`"-"` 表示读 stdin，null 表示未给该选项 */
      inputFile: string | null;
      voice: string | null;
      rateWpm: number | null;
      output: string | null;
    }
  | { kind: "passthrough"; argv: string[] }
  | { kind: "usage-error"; message: string };

type CanonicalFlag = "voice" | "rate" | "output" | "input";

/**
 * 受支持面 = man say 里本 shim 自己实现的选项。不在此表的选项一律整条透传，
 * 长尾（-a/-n/--progress/--interactive/音频格式族）由 /usr/bin/say 兜住，
 * 兼容面因此是「say 的子集 + 其余原样转交」而不是逐项复刻。
 */
const SUPPORTED_FLAGS: ReadonlyMap<string, CanonicalFlag> = new Map<string, CanonicalFlag>([
  ["-v", "voice"],
  ["--voice", "voice"],
  ["-r", "rate"],
  ["--rate", "rate"],
  ["-o", "output"],
  ["--output-file", "output"],
  ["-f", "input"],
  ["--input-file", "input"],
]);

/** 负数与 `-` 开头的正文（如 "-1 tests failed"）会被当成选项名，落到透传分支由系统 say 处理 */
function looksLikeFlag(token: string): boolean {
  return token.startsWith("-") && token.length > 1;
}

function parseRate(raw: string): number | null {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function parseArgv(argv: readonly string[]): CliRequest {
  const texts: string[] = [];
  let inputFile: string | null = null;
  let voice: string | null = null;
  let rateWpm: number | null = null;
  let output: string | null = null;
  let flagsEnded = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;

    if (flagsEnded) {
      texts.push(token);
      continue;
    }
    if (token === "--") {
      flagsEnded = true;
      continue;
    }
    if (!looksLikeFlag(token)) {
      texts.push(token);
      continue;
    }

    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? null : token.slice(eq + 1);
    const canonical = SUPPORTED_FLAGS.get(name);
    // 透传判定必须先于取值校验：`--progress -v`（缺值）该整条交给系统 say，而不是被本层判成用法错误
    if (canonical === undefined) return { kind: "passthrough", argv: [...argv] };

    let value = inline;
    if (value === null) {
      const next = argv[i + 1];
      if (next === undefined) return { kind: "usage-error", message: `选项 ${name} 缺少参数值` };
      value = next;
      i++;
    }

    if (canonical === "voice") {
      // `?` 不是音色名而是 man say 明示的列表模式：列表要经 inherit 直达终端。
      // 若当普通音色走合成通道，系统 say 会转为打印列表并忽略正文，
      // stdout 被采集通道吞掉，最终表现为无声、无列表、exit 0 的静默空操作。
      if (value === "?") return { kind: "passthrough", argv: [...argv] };
      voice = value;
    } else if (canonical === "output") {
      output = value;
    } else if (canonical === "input") {
      inputFile = value;
    } else {
      const rate = parseRate(value);
      if (rate === null) {
        return { kind: "usage-error", message: `语速须是正数（单位 wpm），收到 "${value}"` };
      }
      rateWpm = rate;
    }
  }

  return { kind: "speak", texts, inputFile, voice, rateWpm, output };
}
