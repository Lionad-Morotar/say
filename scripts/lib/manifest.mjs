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
    candidates: [
      {
        // 官方动画短片（D.Va 主演，Charlet Chung 美配）：91-119s 为 Hana 严肃独白
        //（"We barely won last time..."），情绪平稳连续、单角色无叠话；全片带配乐
        //（451s 仅一段静音实测）须人声分离；窗口经 whisper 全片对白时间轴选定
        id: "shooting-star-en",
        kind: "ytdlp",
        url: "https://www.youtube.com/watch?v=7Ngl2I14BR0",
        pageUrl: "https://overwatch.blizzard.com/en-us/media/",
        language: "en",
        dub: "en-US（Charlet Chung）",
        cut: { startS: 91.5, endS: 119.5 },
        separate: { tool: "demucs", version: "4.1.0", args: "htdemucs --two-stems=vocals，粗截外扩 5s" },
        textSource: "whisper 转写（openai-whisper 20250625，模型 large-v3-turbo），与全片对白时间轴互证；专名 Kishin 按官方设定校正（whisper 输出在 Kyushin/Kishin 间漂移）",
        transcribe: { tool: "whisper", model: "turbo", language: "en", corrections: "专名 Kishin 按 Overwatch 官方设定校正（whisper 大小写提示下输出 Kyushin，音素一致）" },
      },
      {
        // 兜底：OW2 游戏语音全集（干音、825 段静音间隙实测无 BGM），但为碎片化短句
        id: "ow2-all-clips",
        kind: "ytdlp",
        url: "https://www.youtube.com/watch?v=0jC3oY6UUCE",
        pageUrl: "https://overwatch.fandom.com/wiki/D.Va/Quotes",
        language: "en",
        dub: "en-US（Charlet Chung，游戏内语音）",
        cut: { startS: 96, endS: 126 },
        textSource: "whisper 转写（openai-whisper 20250625，模型 large-v3-turbo），与 overwatch wiki D.Va/Quotes 官方台词互证",
        transcribe: { tool: "whisper", model: "turbo", language: "en" },
      },
    ],
  },
  lucy: {
    displayName: "Lucy（Cyberpunk Edgerunners，美配英语）",
    candidates: [
      {
        // 第2集结尾月球 braindance 场景（Netflix 美配音轨，社区转录上传）：
        // 8.62-18.76s 为 Lucy 向 David 解说 BD 原理的连续独白，平静语气、单角色无叠话；
        // 有官方英文字幕逐字稿，故走 text 免转写（决策：官方文本优先于 whisper）。
        // 场景全程 BGM（silencedetect 35dB/0.8s 实测 0 静音段）须人声分离
        id: "ep2-moon-bd-en",
        kind: "ytdlp",
        url: "https://www.youtube.com/watch?v=XS5wcjZgnbQ",
        pageUrl: "https://www.netflix.com/title/81054853",
        language: "en",
        dub: "en-US（Emi Lo）",
        cut: { startS: 8.4, endS: 18.9 },
        separate: { tool: "demucs", version: "4.1.0", args: "htdemucs --two-stems=vocals，粗截外扩 5s" },
        text: "That's through your personal link. It's what allows you to feel the heat of the sun. Of course, you'd be fried crispy if I gave you the actual temp. I made sure to lower the settings, mellow out the experience.",
        textSource: "Netflix 官方英文字幕逐字稿（tvshowtranscripts.ourboard.org s01e02《Like A Boy》转录页 + getyarn.io 字幕库双源互证；窗口边界经 whisper 生产预览时间轴 8.62-18.76s 核定）",
      },
    ],
  },
  frieren: {
    displayName: "芙莉莲（葬送的芙莉莲，日配主收）",
    candidates: [],
  },
};
