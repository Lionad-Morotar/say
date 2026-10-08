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
      preset: string | null;
      /** 自研 flag：逐次调用指定引擎，优先级高于 SAY_ENGINE 与 config（engine-v2 切换面） */
      engine: string | null;
    }
  /** 引擎管理子命令（say engine ls/use），编排层经注册表与 say-lab 安装状态执行 */
  | { kind: "engine"; action: "ls" | "use"; name: string | null }
  /** 常驻 daemon 管理子命令（say daemon ls/stop，热启动 S6）：ls 只读探测注册点；
   *  stop 目标是引擎名或 "all"（无参与 --all 同义，票 05 形态），合法性校验归编排层 */
  | { kind: "daemon"; action: "ls" }
  | { kind: "daemon"; action: "stop"; target: string }
  | { kind: "passthrough"; argv: string[] }
  | { kind: "usage-error"; message: string };

type CanonicalFlag = "voice" | "rate" | "output" | "input" | "preset" | "engine";

/**
 * 受支持面 = man say 里本 shim 自己实现的选项，外加自研的 --preset（预设选择）
 * 与 --engine（引擎切换）。不在此表的选项一律整条透传，
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
  ["--preset", "preset"],
  ["--engine", "engine"],
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
  // 引擎管理子命令只认精确形态（engine ls / engine use <name>）：
  // 识别出管理动词但形态不齐（多余词、缺名、flag 形名）吵闹报用法错误，静默吞词比报错更背离 shadow 兼容承诺；
  // engine 后跟其他词（`say engine is loud`）整句回落文本合成，朗读面不因管理面收窄
  const [head, second, third, fourth] = argv;
  if (head === "engine") {
    if (second === undefined) {
      return { kind: "usage-error", message: "engine 需要子命令：say engine ls 或 say engine use <name>" };
    }
    if (second === "ls") {
      if (third !== undefined) return { kind: "usage-error", message: "engine ls 不接受额外参数" };
      return { kind: "engine", action: "ls", name: null };
    }
    if (second === "use") {
      if (third === undefined || third.startsWith("-") || fourth !== undefined) {
        return { kind: "usage-error", message: "engine use 需要恰好一个引擎名：say engine use <name>" };
      }
      return { kind: "engine", action: "use", name: third };
    }
  }
  // daemon 管理子命令与 engine 同一精确形态纪律（热启动 S6）：
  // 动词在、形态不齐吵闹报用法错误；daemon 后跟其他词（`say daemon is quiet`）整句回落文本朗读
  if (head === "daemon") {
    if (second === undefined) {
      return { kind: "usage-error", message: "daemon 需要子命令：say daemon ls 或 say daemon stop <engine|--all>" };
    }
    if (second === "ls") {
      if (third !== undefined) return { kind: "usage-error", message: "daemon ls 不接受额外参数" };
      return { kind: "daemon", action: "ls" };
    }
    if (second === "stop") {
      if (fourth !== undefined) return { kind: "usage-error", message: "daemon stop 不接受额外参数" };
      return { kind: "daemon", action: "stop", target: third === undefined || third === "--all" ? "all" : third };
    }
  }

  const texts: string[] = [];
  let inputFile: string | null = null;
  let voice: string | null = null;
  let rateWpm: number | null = null;
  let output: string | null = null;
  let preset: string | null = null;
  let engine: string | null = null;
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
    } else if (canonical === "preset") {
      preset = value;
    } else if (canonical === "engine") {
      engine = value;
    } else {
      const rate = parseRate(value);
      if (rate === null) {
        return { kind: "usage-error", message: `语速须是正数（单位 wpm），收到 "${value}"` };
      }
      rateWpm = rate;
    }
  }

  return { kind: "speak", texts, inputFile, voice, rateWpm, output, preset, engine };
}
