import type { Host } from "./host.ts";

/** 内置预设表的键集就是 en/zh 二元，locale 归一不引入第三键 */
export type LocaleLang = "en" | "zh";

/** macOS 系统语言真源：defaults 走 cfprefsd，比解析 plist 文件稳定 */
const DEFAULTS_BIN = "/usr/bin/defaults";

/**
 * 一次性系统语言探测：AppleLanguages 优先（系统设置里的语言序）、LANG 兜底（shell 会话显式覆盖）、缺省 en。
 * 任何一环失败都静默降级到下一环——语言只决定默认预设的选择，不该让出声链路为它失败。
 * 归一是二元 zh/en：主子标签 zh 归 zh，其余（含 yue、fr）落 en，一期近似。
 */
export async function detectLocale(host: Host): Promise<LocaleLang> {
  try {
    const outcome = await host.spawn(DEFAULTS_BIN, ["read", "-g", "AppleLanguages"]);
    const fromSystem = primaryLang(outcome.stdout);
    if (fromSystem !== null) return fromSystem;
  } catch {
    // defaults 不可达（非 macOS 环境）不算错误：LANG 兜底与缺省 en 都能接住
  }
  return primaryLang(host.env.LANG ?? "") ?? "en";
}

/**
 * 从 locale 原料取主子标签。两种形态都认：
 * defaults 的 plist 输出（`(\n    "zh-Hans-CN",\n …)`，取首个引号条目）与
 * LANG 环境变量（`zh_CN.UTF-8`，点号分隔编码、下划线分隔地区）。
 * 无引号条目的包裹括号要剥掉（defaults 对无特殊字符的值不加引号，`(zh)` 是合法输出）；
 * 剥后为空（如空数组 `()`）返回 null 让调用方落 LANG 兜底，非 zh 的主标签一律 en。
 */
function primaryLang(raw: string): LocaleLang | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const quoted = trimmed.match(/"([^"]+)"/)?.[1];
  const token = (quoted ?? trimmed).replace(/^[()]+|[()]+$/g, "").trim();
  if (token.length === 0) return null;
  const primary = token
    .split(/[.\s]/)[0]
    ?.split(/[-_]/)[0]
    ?.toLowerCase();
  if (primary === undefined || primary.length === 0) return null;
  return primary === "zh" ? "zh" : "en";
}
