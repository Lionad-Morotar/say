import { EngineError, messageOf } from "./errors.ts";
import type { Host } from "./host.ts";

/**
 * 角色音色解析：`~/.local/share/say/voices/<character>/` 下的
 * `meta.json + ref.wav + ref.txt`（语言变体为 `ref-<variant>.*`）→ 引擎克隆参数。
 * 目录即注册表：新角色放文件即可，不需要改代码（蓝图「注册表/扩展点」节）。
 */

export interface CloneVoiceRef {
  character: string;
  variant: string | null;
}

export interface CloneVoiceSpec extends CloneVoiceRef {
  audioPath: string;
  textPath: string;
}

/**
 * 参考转写正文化：ref.txt 尾部带 `# 转写来源` 溯源注释行（采集层的溯源约定），
 * 整文件当参考文本会把注释一并喂给克隆模型——参考文本与音频内容失配时，
 * ZipVoice 的产出时长畸短且韵律崩坏，实测 8 词英文只出 0.84s（CLI 冒烟同文本 3.0s）。
 * 注释行以 `#` 开头，正文本身不含该形态的行。
 */
export function transcriptOf(raw: string): string {
  const body = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .trim();
  if (body.length === 0) {
    throw new EngineError("参考转写剥离溯源注释后为空：ref.txt 需要至少一行正文");
  }
  return body;
}

/**
 * 音色名 → 角色引用。目录直名优先（无变体），否则按连字符拆出变体。
 * 认领信号是角色目录在盘（不是 meta.json）：目录在而 meta 缺失的角色要能被认领，
 * 才会得到「meta.json 缺失或损坏」这种能修的报错，而不是笼统的「未登记音色」。
 * 谁也不认领的名字由路由层交给配置引擎报「未登记」，
 * `-v nosuch` 的报错因此来自配置引擎而不是凭空指向一个不存在的角色目录。
 */
export function splitVoiceName(host: Host, voicesDir: string, name: string): CloneVoiceRef | null {
  const entries = host.listDirEntries(voicesDir);
  if (entries.includes(name)) return { character: name, variant: null };
  const cut = name.lastIndexOf("-");
  if (cut > 0) {
    const character = name.slice(0, cut);
    if (entries.includes(character)) return { character, variant: name.slice(cut + 1) };
  }
  return null;
}

/**
 * 解析角色资产的克隆参数。资产缺失或转写缺失在这里报精确原因，
 * 交由回退层把一行原因写上 stderr——角色目录在盘而资产不全，比「未登记音色」更值得点名。
 */
export async function resolveCharacterVoice(host: Host, voicesDir: string, name: string): Promise<CloneVoiceSpec> {
  const ref = splitVoiceName(host, voicesDir, name);
  if (ref === null) {
    throw new EngineError(`zipvoice 未登记角色音色 "${name}"（${voicesDir} 下没有对应角色目录）`);
  }
  const dir = `${voicesDir}/${ref.character}`;
  let meta: unknown;
  try {
    meta = JSON.parse(await host.readFileText(`${dir}/meta.json`));
  } catch (error) {
    throw new EngineError(`角色 "${ref.character}" 的 meta.json 缺失或损坏：${messageOf(error)}`);
  }
  const suffix = ref.variant === null ? "" : `-${ref.variant}`;
  const audioPath = `${dir}/ref${suffix}.wav`;
  const textPath = `${dir}/ref${suffix}.txt`;
  const missing = [audioPath, textPath].filter((file) => !host.fileExists(file));
  if (ref.variant !== null && !variantsOf(meta).has(ref.variant)) {
    throw new EngineError(`角色 "${ref.character}" 没有语言变体 "${ref.variant}"（meta.json variants 未声明）`);
  }
  if (missing.length > 0) {
    const names = missing.map((file) => file.slice(dir.length + 1)).join(", ");
    throw new EngineError(`角色 "${ref.character}"${ref.variant === null ? "" : `（变体 ${ref.variant}）`}资产不完整：缺少 ${names}`);
  }
  return { ...ref, audioPath, textPath };
}

function variantsOf(meta: unknown): ReadonlySet<string> {
  const keys = new Set<string>();
  if (typeof meta === "object" && meta !== null) {
    const variants = (meta as Record<string, unknown>).variants;
    if (typeof variants === "object" && variants !== null) {
      for (const key of Object.keys(variants as Record<string, unknown>)) keys.add(key);
    }
  }
  return keys;
}

/** meta.json 里声明的语言。en/zh 之外的（如日配）按多语记，列表分组与语言路由都够用 */
export function cloneVoiceLanguage(meta: unknown, variant: string | null): string | null {
  if (typeof meta !== "object" || meta === null) return null;
  const record = meta as Record<string, unknown>;
  if (variant !== null && typeof record.variants === "object" && record.variants !== null) {
    const spec = (record.variants as Record<string, unknown>)[variant];
    if (typeof spec === "object" && spec !== null) {
      const language = (spec as Record<string, unknown>).language;
      if (typeof language === "string") return language;
    }
  }
  return typeof record.language === "string" ? record.language : null;
}