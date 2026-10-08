# 引擎子进程协议（engine-protocol v1）

引擎层 v2 的统一 shim 协议：Node 宿主与各 TTS 引擎的 Python 侧薄封装（shim）之间的 stdin/stdout JSON 行协议。蓝图裁决 4 钉版，S3 由 GPT-SoVITS 先行落地，S4（VoxCPM）/S5（IndexTTS）/S6（FireRedTTS3）复用同一契约，只换 shim 内核。

协议的 TS 侧执行面在 `src/engines/gptsovits-protocol.ts`（编解码纯函数）与 `src/engines/daemon-session.ts`（常驻形态的连接与握手面）；Python 侧执行面按引擎各一份：`scripts/shims/gptsovits-shim.py`、`scripts/shims/indextts-shim.py`（后者已落 per-call + daemon 双形态）。改帧格式两侧 shim 同改。

## 帧格式

- 一行一个 JSON 对象，UTF-8，`\n` 结尾。传输两形态共用此帧面：per-call 走 stdin/stdout 管道；常驻 daemon 走 unix socket 双向流。帧不动、只换传输。
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
| `text_lang` | 合成文本语言（zh/en/ja），**Node 侧自判**（假名优先 → 中英字符占比 heuristic，与 default 参考判定同源；261007 ja 进语种域，票 09 裁决）。不用引擎侧 `"auto"`：其对短中文文本会误判 ja（fast_langdetect 汉字共享缺陷），误判即用日文音素读中文——反之纯汉字无假名日文句不可分按 zh 走，是接受的边界 |
| `speed_factor` | 语速倍率（1.0 = 原速；say 侧 wpm→倍率换算后传入） |
| `control`（可选） | 引擎侧自然语言控制指令（S4 起，VoxCPM voice creation 首个消费方）。语义由 shim 定义：VoxCPM shim 把它拼成 `(指令)正文` 的括号前缀（control 与文本同通道、无独立参数位的引擎形态）；不出声的 shim 忽略此字段。Node 侧不发默认值——无指令时字段缺席 |
| `duration_factor`（可选） | 时长倍率（S5 起，IndexTTS 消费）：值越大音频越长、语速越慢，1.0 = 原速，合法域 0.5-2.0（与 `speed_factor` 的语速倍率互为倒数——语义反向，故独立字段不复用）。Node 侧由 `-r`（wpm）换算：`1 / wpmToSpeed(rateWpm)`，wpm 锚点与 clamp 域跨引擎同源。缺席 = 引擎默认 1.0 |
| `emo_alpha`（可选） | 情感强度预留（S5 起，IndexTTS 语义域 0-1）：需与引擎侧情感参考配对才生效，缺席 = 纯说话人克隆无情感引导。一期 adapter 不发送（emo 参考链路合成耗时翻倍，默认情感面归试听简报后裁决），协议面先钉位 |

字段名与 GPT-SoVITS api_v2 `/tts` 一比一同名，排障时两形态直接对照。其他引擎复用时字段语义不变；引擎特有参数（如 IndexTTS 的 duration_factor、emo_alpha）作为**新增可选字段**追加，不得复用既有字段名。

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

daemon 常驻形态的 ready 额外携带**握手版本键**（per-call 形态不携带，消费方忽略未知字段）：

```json
{"type":"ready","engine":"gptsovits","version":"v2","device":"cpu","protocol":"2","weights_fingerprint":"<sha256 hex>"}
```

| 字段 | 说明 |
|---|---|
| `protocol` | 协议版本常量，与 Node 侧同仓同步 bump；漂移只发生在「旧代码拉起的旧 daemon」场景 |
| `weights_fingerprint` | 权重面磁盘投影：per-engine 权重清单（`rel\|size\|mtime_ms` 升序 join）的 sha256，TS 与 Python 双实现由对拍测试钉死；升级重装清单变 → 指纹变 → 旧 daemon 握手自动失效。清单按引擎安装面形态选取：gptsovits 取 `.install-ok` 安装 marker 六件套，indextts 取主权重十件文件级（`checkpoints/*` + `index-tts/examples/voice_01.wav`；无安装 marker 可取，auto 层首跑自拉件排除防噪声击穿） |
| `pid` | daemon 自述 pid：Node 侧对 pid 文件执行 kill 前与本字段核对，不符即拒 kill 拒清文件（pid 文件可能指向被复用的无辜进程）；旧 shim 无此字段，缺席时不校验、维持原 kill 语义 |

任一不符 = 过期常驻进程（跑的是旧代码或旧权重），Node 侧判 SIGKILL + unlink sock + 重拉一次封顶；不做热切权重——进程内存混两套状态产错音无从归因。

## 会话生命周期

- **进程形态**：Node 宿主 spawn shim（`<venv python> <shim.py> --repo <引擎仓库根>`），per-call 常驻——一次 CLI 调用内 N 次合成复用同一进程（首块付冷启动，后续热态），调用结束随宿主进程收尾。
- **常驻形态（daemon，四 shim-daemon 引擎 gptsovits/indextts/firered/voxcpm 均已实装）**：`--daemon [--idle-minutes N]` 拉起（闲置收割阈值 per-engine 内置表：indextts 30min、gptsovits/voxcpm 15min、firered 5min——冷启动越贵保温越久，firered 因 39GB 显存档反其道尽快让出），bind `<lab>/daemon.sock` 先于模型加载（加载期连接排队等待，就绪广播 ready），冷启动整个 burst 只付一次、跨 CLI 调用复用。帧面与 per-call 逐字一致，仅传输换成 socket；daemon 的 ready 必携带握手版本键（见上节）。bind 成功即自写 `<lab>/daemon.pid`（getpid）——unix socket 拿不到对端 pid，这是 Node 侧 kill 过期 daemon 的唯一句柄；stdio 启动即重定向 `<lab>/daemon.log`（拉起方 CLI 随时退出会关闭继承管道，引擎写死管道即死），协议帧不占 stdio。
- **bind 竞态裁决（完整仲裁）**：EADDRINUSE 时探针 connect 既有 sock——可连 = 活体已在位，本次拉起判负 exit 3（绝不动赢家的 sock/pid）；不可连 = 僵死残file，清掉重 bind，二次 EADDRINUSE（unlink-rebind 窗口刚被他人接管）同样 exit 3 判负——陈旧文件不能赢过在位者。Node 侧输家观察到 exit 3 后转 connect 轮询等赢家 ready（上限 = 该引擎加载窗，per-engine 值见下方超时表），成功即转温路径复用；等待超时判降级且不做破坏面（不 kill、不 unlink 他人残file）。「sock 可连先于 exit 3 观察到」的交叠窗口：握手失败处置期补观察一次 spawn 句柄，退出码若为 3 即改走 pid 文件归属核对，防空杀已退句柄、误 unlink 赢家注册点。
- **既有 daemon 的加载宽限窗**：bind 先于加载使「加载中赢家」与「僵死 daemon」在握手面不可分辨（都可连、ready 都迟到）。warm 直连 5s 初判未 ready 不即 kill：以 `<lab>/daemon.pid` 的 mtime 年龄判加载窗（`readyTimeout` 内 = 可能还在加载，同连接宽限续等；该阈值 per-engine，值见下方超时表），窗尽仍无 ready 才进 kill + 重拉。pid 文件缺失或年龄超窗维持僵死语义。
- **daemon 生命周期**：闲置收割由 daemon 自计时自退（无请求、队列排空且无在位连接超阈）；SIGTERM 与 `shutdown` 帧优雅自退；两者退出均清 sock/pid。宿主 CLI 退出不收走 daemon（自持文件与信号生命周期）。Node 侧连接断开、ready 不符、请求超时等**基础设施失败**降级 per-call 重放同一请求（本次调用内不再重试 daemon，新调用自然重触）；`error`/`fatal` 帧是**引擎级确定性失败**，不降级重放（同一请求 per-call 必复现，重放白付进程成本）。
- **故障熔断（跨 CLI 进程经文件会合）**：daemon 形态的基础设施失败（拉起/握手/在途）收敛计数进 `<lab>/daemon-failures`（JSON `{count,lastAt,openedAt}`，清零后多一个 `freshAt` 哨兵键；tmp+rename 原子写，tmp 名带毫秒与 pid 分区防跨进程同毫秒碰撞）。滑动窗 10min 内累计 3 次开冷却闸：冷却期会话入口直拒 daemon 路径（连健康 daemon 都不复用、不 spawn、跳过不计数），请求直接 per-call；10min 到期自动放行一次重试。一次成功的温态合成（done 帧）原子写零记录清零（count 0 + 清零哨兵，文件不删；record 写回前复读一次现文件，基线被清零覆盖即放弃写回，陈旧计数不会把冷却窗复活）。文件损坏/不可读写判「闭合」放行——熔断器误闸拦路比漏闸更伤；计数尽力而为，多 CLI 竞态残余窗口收窄为单次首读与复读的微秒间隙，窗内丢一次清零的后果是冷却窗复活 ≤10min 走 per-call，丢一次计数只影响开窗时机，出声下限不破。
- **SAY_DAEMON 逃生门**：`off` = 装配点根本不接 daemon 会话，合成退回 per-call 单形态（健康 daemon 在位也不连，与 daemon 上线前行为同形），off 不是失败、不进熔断；`on`/缺席/空串 = daemon-first 缺省；其它值告警并跳过本层（三层链 `SAY_DAEMON` env > config `[daemon]` > 内置缺省，坏值跳层不劫持下层——环境层坏值降级哲学：一个 typo 不该砍掉出声下限，更不该劫持用户在下层的明确表态）。`[daemon]` 节已落地：`enabled` 总开关、`idle_minutes` 全局与 `[daemon.idle]` 分引擎两级闲置阈值，各层坏值一律跳层并警告。
- **收尾**：Node 关闭 stdin（EOF）即 shim 优雅退出；SIGTERM/SIGKILL 同样终止。无显式握手关停协议。
- **并发与排队**：请求可并发下发，shim 侧单飞串行处理（推理本身串行），响应按完成序回、`id` 配对（`id` 为连接内序号，非全局唯一，daemon.log 归因时注意）。Node 侧实现（四 binding）对同引擎实例做了请求互斥，第二请求排队。daemon 等待队列有界 **4**（不含在途请求）：满员的新请求收 `error` 帧，message 携带固定前缀 `daemon queue full`——TS 侧按前缀识别为容量瞬态，转 per-call 重放且 daemon 不判死、不进熔断；拒转不关连接（关连接会伪装成在途 EOF 误计失败）。该 message 是跨语言契约，TS 常量与 shim 源文本由对拍测试钉死。
- **超时**（Node 侧）：daemon 温态直连握手 5s（温态 ready 应即时，长等即僵死判据，全局缺省）；ready 加载窗与温态单请求为 per-engine 四行投影，数值与四 binding 导出常量同源（同口径原则：daemon 加载窗与 per-call ready 同值、温态单请求与 per-call 同预算线——主路径不严于退路；`say daemon ls` 的「加载中」判定窗复用同一数）。超时即杀进程，收敛为合成失败进回退链（daemon 形态先经 per-call 降级）：
  - gptsovits：ready 120s（显式导出=全局缺省；冷启动实测常态 ~12s，余量覆盖首跑 JIT 与慢盘）、温态单请求 60s（继承全局缺省：纯推理秒级 + 排队余量，不含加载成本）、per-call 单请求 180s。
  - indextts：ready 240s（per-call 同口径：5GB 权重 + MPS 初始化 + auto 层首跑自拉余量，实测首跑 76.7s）、温态单请求 60s（继承缺省：温态单请求被 say 层分块界定）、per-call 单请求 180s。
  - firered：ready 240s（20.8GB 权重 + MPS 初始化 + 首跑 kernel 编译余量）、温态单请求 180s（与 per-call 合成同口径显式放宽：长文本引擎内拆句多段串行，60s 缺省会误杀健康慢合成）、per-call 合成 180s。
  - voxcpm：ready 180s（from_pretrained + optimize 构造期 warm-up 一次完整合成，含慢盘 torch.compile 余量）、温态单请求 180s（与 per-call 帧间活动 180s 同预算线的绝对制落点：流式总时长随句长变化且叠加 ≤4 路排队）、per-call 帧间活动 180s（流式形态，见音频块节）。
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
| daemon 基础设施失败（拒连/拉起死/握手不符/在途 EOF/请求超时/输家等待超时） | DaemonSession 分类为 `DaemonUnavailableError`，markUnavailable 收敛处计入熔断文件 | 降级 per-call 重放同一请求（实例内 sticky）；跨进程累计 3 次/10min 开冷却闸直拒 daemon；温态成功清零；`SAY_DAEMON=off` 逃生门整体禁用 |
| daemon 队满拒转（error 帧 message 前缀 `daemon queue full`） | TS 侧前缀识别（跨语言对拍钉死） | 容量瞬态非失败：转 per-call 重放，daemon 不判死、不进熔断 |

回退语义见 `src/fallback.ts`：`fallback: system` 时回退系统嗓出声、stderr 一行（`fallback: ` 前缀）、exit 0。

## 验收锚点（GPT-SoVITS S3 实测口径）

- zh/en 短句热合成 ≤3s（同进程第二次合成计时，对齐调研报告口径）。
- 冷合成 ≤10s。
- 杀进程模拟 → system 回退出声 + stderr 一行 + exit 0。

## 修订规则

- 本文档是 S4-S6 接入的唯一契约源；改字段/帧型先改这里再动两侧执行面。
- 引擎特有扩展走「新增可选字段」，通用面变更（帧格式、三消息型、握手）须四引擎 shim 同步。
