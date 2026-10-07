# 引擎子进程协议（engine-protocol v1）

引擎层 v2 的统一 shim 协议：Node 宿主与各 TTS 引擎的 Python 侧薄封装（shim）之间的 stdin/stdout JSON 行协议。蓝图裁决 4 钉版，S3 由 GPT-SoVITS 先行落地，S4（VoxCPM）/S5（IndexTTS）/S6（FireRedTTS3）复用同一契约，只换 shim 内核。

协议的 TS 侧执行面在 `src/engines/gptsovits-protocol.ts`（编解码纯函数）；GPT-SoVITS 的 Python 侧执行面在 `scripts/shims/gptsovits-shim.py`。改帧格式两处同改。

## 帧格式

- 一行一个 JSON 对象，UTF-8，`\n` 结尾。
- 文本内容中的换行由 JSON 字符串转义承担，天然不成帧。
- 杂散行容忍：引擎库向 stdout 的杂散打印（i18n 提示、耗时统计）由消费方按「解析不了的行丢弃」处理，不毒化协议面。shim 侧仍有义务把协议通道与引擎日志分离（GPT-SoVITS shim 用 fd 1 副本 + `sys.stdout` 改道 stderr 的启动序）。

## 消息型

三消息型 + 握手：

### 1. 合成请求（Node → shim）

```json
{"type":"synthesize","id":1,"text":"你好世界","ref_audio_path":"/path/ref.wav","prompt_text":"参考转写","prompt_lang":"zh","text_lang":"zh","speed_factor":1.0}
```

| 字段 | 说明 |
|---|---|
| `id` | 请求关联 id（自增）。shim 不解释只回传；Node 侧按 id 配对响应 |
| `text` | 待合成文本（调用方已切好块，shim 内不再切分） |
| `ref_audio_path` | 参考音频的 **shim 可见绝对路径**（零样本克隆必带） |
| `prompt_text` | 参考音频的文字转写，必须与音频内容严格对应 |
| `prompt_lang` | 参考音频语言（api_v2 枚举：`auto/auto_yue/en/zh/ja/yue/ko/all_zh/...`） |
| `text_lang` | 合成文本语言，**Node 侧自判**（中英字符占比 heuristic，与 `prompt_lang` 的 default 参考判定同源）。不用引擎侧 `"auto"`：其对短中文文本会误判 ja（fast_langdetect 汉字共享缺陷），误判即用日文音素读中文 |
| `speed_factor` | 语速倍率（1.0 = 原速；say 侧 wpm→倍率换算后传入） |
| `control`（可选） | 引擎侧自然语言控制指令（S4 起，VoxCPM voice creation 首个消费方）。语义由 shim 定义：VoxCPM shim 把它拼成 `(指令)正文` 的括号前缀（control 与文本同通道、无独立参数位的引擎形态）；不出声的 shim 忽略此字段。Node 侧不发默认值——无指令时字段缺席 |

字段名与 GPT-SoVITS api_v2 `/tts` 一比一同名，排障时两形态直接对照。其他引擎复用时字段语义不变；引擎特有参数（如 IndexTTS 的 duration_factor）作为**新增可选字段**追加，不得复用既有字段名。

### 2. 音频块（shim → Node）

```json
{"type":"audio","id":1,"pcm":"<base64>","sample_rate":32000,"done":true}
```

- `pcm`：int16 LE 裸样本的 base64（与 GPT-SoVITS 输出的 wav 采样格式同源，值域 [-32768, 32767]）。
- `sample_rate`：采样率由 shim 透出，Node 侧不硬编码。
- 流式形态：同一 `id` 可有多块，尾块 `done=true`；非流式 shim 一块即带 done。Node 侧按到达序拼接。
- 流式 shim 的块发送约定（S4 起，VoxCPM 先行）：引擎流式 API 的生成器只有再取一次才知耗尽，故 shim 缓存上一块、下一块到达才发出（`done=false`），生成器耗尽后以 `done=true` 发出最后缓存块——尾块带最后一段音频与 S3 消费侧「尾块计入拼接」语义一致；单块流即一帧 `done=true`；零块流发 `error` 帧（进程存活语义）。代价是每块多一次块时长的发送缓冲（亚秒级），换协议帧型零改动。
- 流式消费的超时语义（Node 侧）：流式请求的总时长不可预知，整请求 deadline 换成帧间活动性 deadline——每收一帧重置，静止超时判死杀进程。坏例重试的延迟翻倍（整句形态最多 3 次）由活动性语义天然覆盖。
- 失败形态：

```json
{"type":"error","id":1,"message":"ref_audio_path 不存在"}
```

请求级错误：进程保持存活，可继续下一请求。`id` 无法归属（如请求 JSON 损坏）时用 `-1`。

### 3. 致命错误（shim → Node）

```json
{"type":"fatal","message":"权重缺失"}
```

加载期失败（模型/权重/依赖问题），shim 随后退出。无请求可归属，无 `id`。

### 握手：就绪（shim → Node）

```json
{"type":"ready","engine":"gptsovits","version":"v2","device":"cpu"}
```

模型加载完成后 shim 写出的第一协议帧。冷启动（进程拉起到 ready）是一次性成本，GPT-SoVITS v2 CPU 档实测 ~12s。

## 会话生命周期

- **进程形态**：Node 宿主 spawn shim（`<venv python> <shim.py> --repo <引擎仓库根>`），per-call 常驻——一次 CLI 调用内 N 次合成复用同一进程（首块付冷启动，后续热态），调用结束随宿主进程收尾。
- **收尾**：Node 关闭 stdin（EOF）即 shim 优雅退出；SIGTERM/SIGKILL 同样终止。无显式握手关停协议。
- **并发**：请求可并发下发但 shim 侧串行处理（推理本身串行），响应按完成序回、`id` 配对。Node 侧实现（gptsovits-binding）对同引擎实例做了请求互斥，第二请求排队。
- **超时**（Node 侧，gptsovits 实装值）：ready 等待 120s（冷启动 12s 的 10 倍余量）、单请求等待 180s。超时即杀进程，收敛为合成失败进回退链。
- **孤儿兜底**：shim 不做「父进程死了我就自杀」的 stdin EOF 守卫式探测（shell 后台场景 /dev/null 的 EOF 与管道断开不可区分）；生命周期完全由管道 EOF 与信号承载，per-call 形态下宿主退出即管道断开。

## 失败面（全部收敛为引擎合成失败，进 say 回退链）

| 失败 | 检测 | 结果 |
|---|---|---|
| spawn 失败（venv/解释器缺失） | `exit` settle 为 SPAWN_ERROR | EngineError |
| 加载失败（权重缺失、依赖损坏） | `fatal` 帧或加载期 exit（错误带 stderr 末行） | EngineError |
| ready 超时 | deadline 竞速 | EngineError + 杀进程 |
| 合成失败（引擎拒绝请求） | `error` 帧 | EngineError |
| 合成中进程死亡（含杀进程模拟） | `exit` settle | EngineError |
| 合成超时 | deadline 竞速 | EngineError + 杀进程 |
| 空样本/全零样本（静音产出） | Node 侧能量校验 | EngineError |

回退语义见 `src/fallback.ts`：`fallback: system` 时回退系统嗓出声、stderr 一行（`fallback: ` 前缀）、exit 0。

## 验收锚点（GPT-SoVITS S3 实测口径）

- zh/en 短句热合成 ≤3s（同进程第二次合成计时，对齐调研报告口径）。
- 冷合成 ≤10s。
- 杀进程模拟 → system 回退出声 + stderr 一行 + exit 0。

## 修订规则

- 本文档是 S4-S6 接入的唯一契约源；改字段/帧型先改这里再动两侧执行面。
- 引擎特有扩展走「新增可选字段」，通用面变更（帧格式、三消息型、握手）须四引擎 shim 同步。
