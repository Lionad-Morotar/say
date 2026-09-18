// 素材候选清单：每角色按序 fail-fast——前一候选下载/处理/验证失败自动落 raw-log 并试下一候选。
// 候选字段契约：
//   id          候选标识（日志与产物命名用）
//   kind        "direct"（curl 直链文件）| "ytdlp"（视频页取音轨）
//   url         下载地址或视频页地址
//   pageUrl     素材出处页（wiki 台词页等，meta.source_urls 收录）
//   language    台词语言（en/ja/zh）
//   dub         配音版本（如 en-US / ja / zh-CN）
//   cut         { startS, endS } 截取窗口（缺省整段）
//   text        官方逐字台词（有则免转写）
//   textSource  台词文本来源描述（wiki 页/字幕）
//   transcribe  { tool: "whisper", model, language } 无官方文本时的转写方案
//   separate    true 时先经人声分离（处理记录写 meta.processing）
export const CHARACTERS = ["dva", "lucy", "frieren"];

/** @type {Record<string, {displayName: string, candidates: object[]}>} */
export const MANIFEST = {
  dva: {
    displayName: "D.Va（Overwatch，美配英语优先）",
    candidates: [],
  },
  lucy: {
    displayName: "Lucy（Cyberpunk Edgerunners，美配英语）",
    candidates: [],
  },
  frieren: {
    displayName: "芙莉莲（葬送的芙莉莲，日配主收）",
    candidates: [],
  },
};
