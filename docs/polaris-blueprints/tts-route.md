# epic 蓝图：tts-route（状态：定稿 v4，Gate 审查已裁决）

> 迷雾型 epic 蓝图。目标：为「好听的 agent 说话体验」钉死技术路线与切片清单，替代 macOS `say`。
> 方向由用户原话指定（路线偏好：drop-in alias > 现成 CLI > 套壳自建 > 从头自研），本次选向无发散（如实记录，见决策日志 D1）。
> 用户中途补充（2026-09-19，影响路线权重）：① 默认音色希望为角色克隆音色——芙莉莲 / D.Va / 2077 Lucy 候选；② 说话语言以英语为主，中文仅在质量「非常完美」时启用；③ 流程要求——Polaris 级（可颠覆产品的）决策须以完备上下文呈现给用户抉择（如 HTML 架构图/试听 Demo），区别于 FlowDev 的简单决定可用 Ask 快问。其余决定用户授权自由推进。
> 调研输入：`docs/research/2026-09-19-say-direct-alternatives.md`（直接替代品象限）与 `docs/research/2026-09-19-tts-engine-landscape.md`（引擎横评），已合并去重；缝隙补扫（AVSpeechSynthesizer/Personal Voice 前端、商业本地 CLI、brew say 包装器）结论：mac-say-mcp 仅包装原生 say 不改音质、speechify 为 GUI cask 非 CLI、Personal Voice 属音色克隆未来路线——均不改变路线判断。
> 对抗审查：方向审查 `260919-tts-direction`（9 条，裁决台账见下）；蓝图 Gate `260919-tts-route-blueprint`（9 条，裁决台账见下，一轮不循环再审）。

## 现状事实底座

本机实测（2026-09-19，M3 / macOS 15 Sequoia，Darwin 24.6）：

* 已装 zh 音色：Tingting / Meijia / Sinji（老一代）+ Eddy / Flo / Grandma / Grandpa / Reed / Rocko / Sandy / Shelley（人设紧凑音色，zh_CN 与 zh_TW 变体齐全）；无任何 Premium / Enhanced 音色（`~/Library/Speech/Voices/` 不存在，用户从未下载）
* 系统 say 合成基线：22 字中文句 → Tingting ≈ 2.3s、Eddy ≈ 1.9s、Flo ≈ 2.0s（写盘 AIFF，含进程启动）；样本存 `docs/research/samples/baseline-{tingting,eddy,flo}.aiff`，待用户试听
* 本机无任何第三方 TTS CLI；brew core 无任何神经 TTS formula（唯一 brew 通路是 steipete 个人 tap 的 sag）；主流引擎全部走 PyPI/uv/npm/GitHub Releases 分发
* 全局 CC 工作流调用面：`~/.claude/CLAUDE.md` 单行「情绪激动时，使用 bash say 表达你自己」——agent 实际只用 `say <text>` 形态，不带 flag；用户同时运行 ZCode / Codex 等多 runtime，PATH 前置会全局劫持所有调用方
* 用户 shell 基建：`~/.local/bin` 已在 PATH 前置区，用户有成熟 PATH shadow 习惯（find→fd / grep→rg / ls→eza 等）
* 网络前置假设（Gate 发现 7）：模型资产托管在 GitHub Releases（sherpa 系）与 HuggingFace（kokoro/ZipVoice/Qwen3-TTS 系），上海直连两者均不稳定；用户有代理环境（shadow）。下载脚本必须支持代理 env 透传与 HF 镜像（HF_ENDPOINT）fallback，s-deploy 冒烟在实际网络形态下验收并注明所用通道

s-bench 本机实测（2026-09-19，M3，每格 3 次取中位，64 格矩阵，全量见 `docs/research/bench/report.md` 与 raw-log）：

* 系统 say 对照：0.54-0.77s 全 PASS（神经引擎要跨过的体验门槛）
* sherpa-matcha-zh（node）：zh-short 冷 1.29s / 热 0.41s 最快；但单语中文（英文输出退化噪声记 N/A）、单女声、数据集非商用
* sherpa-kokoro-int8（node）：en-short 冷 2.57s / 热 1.59s PASS；zh-short 热 4.25s MARGINAL；en-long 热 ~10s FAIL
* sherpa-zipvoice 占位干音克隆（node）：en/zh 短句热 2.43-2.57s PASS——**克隆嗓进默认延迟预算成立**；en-long FAIL
* mlx-qwen3（子进程）：en-short 热 2.88s PASS、zh-short 热 3.67s MARGINAL、en-long 热 9.12s FAIL；安装体量 1.9GB
* 可行性矩阵六格：kokoro/ZipVoice 双通道（Node 绑定 + spawn）4/4 可用；matcha 2/4（英文退化）；ZipVoice Node 绑定支持成立（静态类型 + 动态合成双证据）
* 长文本（~60 词）全部本地通道热态超标 → v1 处置 = 规范化层分块 + 流水播放（首包 <3s），F2 daemon 已触发但延后（见雾区）

调研关键事实（详表见两份报告）：

* 现成 say 兼容 shim 存在两个：**sag**（steipete，578★，MIT，Go 单二进制，brew tap 可装，say 风格接口 + afplay 流式播放；但后端仅 ElevenLabs/60db 云 API，需 key 按字符计费联网）与 **gensay**（2★，MIT，Python，say 接口复刻最完整 -v/-r/-f/-o/管道，多 provider，本地 chatterbox/vibevoice + 云端，warm daemon 短句 1.4s，LRU 缓存，断网自动回退原生 say；社区验证度≈0，本地 provider 需 ~2GB PyTorch）
* macOS 14+ 为 Apple Silicon 提供 Enhanced/Premium 神经音色（本地 Neural Engine 合成）：社区实测「婷婷增强版接近最好的 Edge 在线语音，100% 本地」；下载入口存在两种说法（辅助功能→朗读内容→管理声音 / VoiceOver 实用工具→语音→+），需 GUI 手动操作，本机未下载
* **sherpa-onnx**（Apache-2.0，v1.13.8 2026-09-10，极活跃）= 本地引擎最强宿主：单运行时承载 Kokoro v1.1 中英 103 音色（int8 CPU）、matcha-icefall-zh-baker（Pi4 RTF 0.391，数据集非商用）、vits-melo-zh_en、**ZipVoice 零样本克隆（123M，zh/en，distill，int8 ONNX CPU 部署，官方文档含 offline-tts 命令，推理需 reference 音频 + reference text）**；中文数字/日期读法有现成 `--tts-rule-fsts` 规则件；macOS arm64 预编译二进制 + Node/Python 绑定；官方建议低延迟场景走 server/常驻
* **常驻化三线证据**（Gate 发现 4）：gensay warm daemon 短句 1.4s、sherpa 官方低延迟建议 server、piper 官方建议 server——spawn-per-call 形态大概率贴线；架构以执行器三态接口预留（见模块模型），daemon 实现留雾区 F2
* **克隆路线格局**（用户补充后升为主验收面）：ZipVoice（本地 CPU 零样本，参考音频即克隆，sherpa 同宿主）／GPT-SoVITS（61.9k★ MIT，少样本微调，质量上限高但重服务化）／IndexTTS-2.5（情绪+时长控制，GPU，bilibili 自定义许可）／fish-speech S2（顶级但 GPU + 研究许可）／ElevenLabs 克隆（付费云，sag 已证明其 say 风格管线可行）
* **角色素材干音可得性**（Gate 发现 3）：D.Va（Overwatch 游戏语音库）与游戏侧素材存在干音源；Lucy（Edgerunners 动画）与 Frieren（动画）官方素材多带 BGM，需选人声分离处理或精选干净对白段；参考音频质量是克隆相似度第一变量
* **mlx-audio + Qwen3-TTS-0.6B-8bit**（MIT，Apple Silicon MLX 原生，`--play` 直播）= 本地中文质量上限候选（阿里开源，中文母语级）；冷启动延迟未实测
* **Kokoro 语言不对称**：英文音色 A 级口碑，中文官方自评比 D 级、短句弱（官方建议 10-20 token 以下合并、400 token 以上赶速），中文社区评「无 GPU 最优」——矛盾口径并列呈真；en-first 补充后 Kokoro 英文音色升为通用备选预设首选；**短句合并/长文分块的文本规范化层为 CLI 必备件**（Gate 发现 5）
* **edge-tts**：免费中文公认标杆（晓晓等六主力+方言），但非官方接口无 SLA：2024-11 大陆 403、2025-12 全球 NoAudioReceived 事故、2026-01 403 复发（issue #458），仓库 push 停在 2026-03；只作质量锚点与可选云预设，不作底座
* Piper 中文仅 huayan-medium 且社区评「D 级感、发音不准夹英文」，项目招募维护者中——出局；Coqui XTTSv2 中文带口音且数 GB 依赖——出局；gtts 停更+大陆不可达——出局；KittenTTS/Dia/OuteTTS 无中文——出局

## 方向对抗审查裁决台账（260919-tts-direction，glm-5.3，9 条）

| # | 发现 | 裁决 | 处置 |
|---|------|------|------|
| 1 | 系统已内置 zh 人设神经音色，epic 或缩为零改动；试听应阻塞蓝图 | 部分接受 | 基线样本已生成，随简报交用户试听；「epic 缩零」驳回：验收信号含可定制 + 角色克隆，系统 say 结构性无法满足。系统音色作对照基线与失败回退目标（D2）。Enhanced/Premium 下载保留为用户可选零代码路径（F1） |
| 2 | 验收测不出「接口完全一致」；真实调用面只有 `say <text>` | 接受 | Q1 钉死兼容面 = `say <text>` 子集 + 未支持参数透传 |
| 3 | 「语气可自定义」与「接口完全一致」内部矛盾 | 接受 | Q2 语气 = 配置预设（音色×语速×引擎组合），扩展面走配置/环境变量 |
| 4 | PATH 前置即全局劫持多 runtime；失败路径未定义 | 接受 | Q3 PATH shadow + 透传 + 失败回退系统音色（Q6） |
| 5 | 并发语义未定义 | 接受 | Q6：并发不崩溃、混叠沿 afplay、-o 用 PID 临时名 |
| 6 | edge-tts 未过「网络依赖」筛子 | 接受 | Q4：默认引擎必须本地离线；云引擎只作可选预设 |
| 7 | p95 延迟伪统计且无基线对照 | 接受 | polaris.md 已改写热 ≤3s / 冷 ≤10s + 基线对照；基线已实测 |
| 8 | 「唯一 active 目标」循环论证 | 接受 | 本蓝图如实标注「方向由用户指定，无发散」 |
| 9 | 调研象限缝隙 | 接受 | 已合并去重 + 缝隙补扫（见顶部注） |

## 蓝图 Gate 审查裁决台账（260919-tts-route-blueprint，glm-5.3，9 条，一轮定稿）

| # | 发现 | 裁决 | 处置 |
|---|------|------|------|
| 1 | 语言策略与真实流量（中文/中英混杂）错配；漏枚举「同角色双语克隆嗓 + 语言路由」 | 部分接受 | 接受：s-bench 矩阵补「中英混合短句」；Q10 补枚举与音色级路由注记（预设一行配置即可换嗓，无需引擎级自动路由）。驳回「D10 押错语言」主张：说话语言英语为主是用户明确指令（原话「使用英语而不是中文（除非中文音色非常完美）」），非决策方臆断；中文流量缺席角色嗓是用户指令下的既定取舍，polaris 验收第二条以英语为口径 |
| 2 | 克隆路线整体失败无 epic 级出口；s-bench 占位克隆是弱证据 | 接受 | 克隆质量归属裁决移至 s-voice（真实素材后）；s-bench 只裁延迟/可行性，占位音频限定为高质量干音（sherpa 官方 ZipVoice 示例 reference 即是）；新增 D14 降级出口：三角色全不达标 → 通用音色 CLI 照常交付 + 验收第二条标记未达成回报用户，升级阶梯（F3/F5）交用户裁决，不静默吸收 |
| 3 | 参考音频三缺口：干音、reference text、cache 目录语义 | 接受 | voices 资产模型改 `ref.wav + ref.txt + meta.json`（来源/语言/许可注记）；素材目录挪 `~/.local/share/say/voices/`（非可再生资产不入 cache）；干音策略入 s-voicepack 验收（游戏语音库干音优先，动画素材选人声分离或干净对白段）；「采集+处理+转写」拆为独立前置切片 s-voicepack（fail-fast），预算升至 5 切片 |
| 4 | 三线证据指向常驻化但架构零预留；S1 验证粒度不分模型类型 | 接受 | s-cli-core 合成执行器抽为三态可替换接口（进程内/子进程/daemon），F2 触发只增实现不重构；s-bench 可行性矩阵按 {kokoro, matcha, ZipVoice} × {Node 绑定, spawn 二进制} 分别出结论 |
| 5 | Kokoro 短句弱需合并策略在蓝图转写中丢失 | 接受 | speak.ts 职责补文本规范化层（超短句处理/长文分块）；s-cli-core 验收补「超短句（<5 字）与超长文本（>400 token）行为」条目 |
| 6 | HR1 论据失真：gensay 的 chatterbox provider 本身是克隆向 | 接受 | HR1 措辞修正为「克隆能力未验证」（chatterbox 为克隆向模型，gensay 是否暴露参考音频接口未验）；简报同步修正；用户若倾向先试 gensay，s-bench 加测 chatterbox 克隆路径 |
| 7 | 模型下载的大陆可达性假设未声明 | 接受 | 事实底座补网络前置假设；下载脚本支持代理透传 + HF_ENDPOINT 镜像 fallback；s-deploy 冒烟注明所用网络通道 |
| 8 | 验收第三条（英/中通用备选音色各≥1）无切片落点 | 接受 | s-voice 验收补显式核对条目：预设表含通用 en/zh 音色各 ≥1，样本入 HTML 简报，e2e 终裁 |
| 9 | env > flag > config 优先级反直觉且无理由 | 接受 | 反转为 flag > env > config（CLI 通行惯例；手动 `-v` 被 env 覆盖属真实困惑场景，原设计无成立理由）；D13 记录；s-voice 单测断言随之修正 |

## 开放点自答（设计树，三轮收敛）

### 第一轮（无前置）

❓ Q1 - 兼容面定义: 替代 CLI 的接口面选哪种？(a) say 全接口逐项复刻 (b) `say <text>` 核心子集 + 常用 flag（-v/-r/-o/stdin），未支持参数原样透传 /usr/bin/say (c) 全新接口不管 say
➡️ 推荐: (b) — 真实调用面只有 `say <text>`，全复刻是为不存在的需求付成本，透传兜住长尾 — 证据：CLAUDE.md 单行调用（事实底座）；方向审查发现 2；gensay 证明全复刻可行但其成本正来自冷门参数矩阵

❓ Q4 - 离线/在线裁决: 默认引擎的网络依赖允许度？(a) 纯本地 (b) 默认本地 + 云预设可选 (c) 云为主本地兜底
➡️ 推荐: (b) — 原 say 的可用性下限是离线永远可用，情绪表达不能等网络也不能被上游封禁；云音色质量上限（edge-tts/ElevenLabs 克隆）保留为显式配置的可选预设 — 证据：方向审查发现 4/6；edge-tts 2024-2026 三次封禁事故时间线；sag 付费云模式被否的唯一硬缺陷即在此

### 第二轮（前置 Q1/Q4 已钉）

❓ Q2 - 「语气」可操作含义: (a) 配置文件预设（音色×语速×引擎组合，如 happy/calm）(b) SSML 情感标签 (c) 情绪引擎（IndexTTS-2.5 级）
➡️ 推荐: (a)，接口为 (c) 留扩展位 — 本地轻引擎（matcha/kokoro/ZipVoice）无情绪控制面，SSML 在免费渠道被微软封死，情绪引擎需 GPU 属雾区；真实定制面只能是配置/环境变量（调用方是不带参数的 agent）— 证据：方向审查发现 3；引擎横评「情绪与表现力需 GPU 服务，留接口」；edge-tts SSML 受限声明

❓ Q3 - 部署形态: (a) PATH shadow `say`（~/.local/bin 前置同名可执行）(b) 独立命令名 + CLAUDE.md 改一行 (c) shell alias
➡️ 推荐: (a)，(b) 为退路 — 命中用户首选「接口完全一致的 alias」且 CLAUDE.md 零改动直接命中验收信号；多 runtime（ZCode/Codex）全部自动受益；shadow 风险由 Q1 透传 + Q6 回退覆盖 — 证据：用户 shadow 习惯与 ~/.local/bin PATH 前置（事实底座）；(c) 否决：非交互 shell 不展开 alias，多 runtime 不可移植（方向审查发现 4）

❓ Q5 - 引擎选型: (a) sherpa-onnx 宿主（matcha-zh / kokoro-v1.1-int8 / ZipVoice 克隆）(b) mlx-audio + Qwen3-TTS (c) 收编 gensay 二开 (d) 收编 sag
➡️ 推荐: 基准测试裁决制——(a) 为工程底座默认（一个宿主同时覆盖通用音色与克隆音色），(b) 为中文质量上限挑战者（en-first 补充后权重下调，仅当用户试听判定其中文「非常完美」才启用），s-bench 实测延迟 + 用户试听裁决默认预设归属；(c)(d) 否决 — 证据：sherpa Apache/极活跃/数字 FST/多模型单宿主/Node 绑定；ZipVoice 官方 int8 CPU 克隆路径同宿主；Kokoro en A 级/zh D 级不对称与用户英语优先正好匹配

### 第三轮（前置 Q2/Q3/Q5 已钉 + 用户角色音色补充）

❓ Q9 - 角色克隆路线（芙莉莲 / D.Va / Lucy）: (a) ZipVoice 零样本（参考音频+转写即克隆，本地 CPU，sherpa 同宿主）(b) GPT-SoVITS 少样本微调 (c) IndexTTS-2.5（情绪控制，GPU）(d) ElevenLabs 克隆（付费云）
➡️ 推荐: (a) 为 v1 克隆路线，(b)(c)(d) 留雾区按触发条件升级 — 零样本免训练、参考音频 10-30s 即可产出、与工程底座同宿主（部署面零新增）；相似度不足时的升级阶梯清晰：(b) 本地微调 → (d) 云端 → (c) 情绪版；(b) 触发即架构哲学跃迁（服务化部署），代价已在 F3 显式标注。跨语种注意点：Frieren 参考音频为日配（官方素材），用其音色说英语属跨语种克隆，相似度需试听裁决；Lucy（美配）/D.Va（美配）有英语官方干音素材，与 en-first 目标天然对齐。素材来源：官方公开语音（游戏语音库干音优先；动画素材经人声分离或精选干净对白），仅本机个人使用，不再分发 — 证据：sherpa ZipVoice 官方文档（int8 zh-en 模型 + reference 音频/文本接口）；GPT-SoVITS/IndexTTS 重量级事实（引擎横评重型组）；干音可得性（Gate 发现 3）

❓ Q6 - 失败路径与并发: 引擎缺失/推理超时/无声卡时行为？
➡️ 推荐: 任何失败回退 `/usr/bin/say`（系统默认音色）+ stderr 一行原因；产生过任何声音即 exit 0；并发不加锁（afplay 自然混叠），-o 输出经 PID 临时文件 — 证据：方向审查发现 4/5；「情绪表达永远可用」= 系统 say 的离线可用性下限

❓ Q7 - 实现栈: (a) Node CLI + sherpa-onnx-node 进程内推理，mlx 走子进程适配 (b) Python CLI (c) 纯 shell 包装 sherpa C++ 二进制
➡️ 推荐: (a)，(c) 为 Node 绑定不可用时的退路 — 用户脚本栈偏好 NodeJS 其次 Python；引擎适配器 + 执行器三态接口（进程内/子进程/daemon）容纳 sherpa/mlx/system 与未来常驻化；s-bench 按 {kokoro, matcha, ZipVoice} × {Node 绑定, spawn} 矩阵验证，克隆主路线的延迟画像按其真实可用通道采集 — 证据：用户全局偏好「脚本优先 NodeJS」；sherpa 官方 Node 绑定；Gate 发现 4

❓ Q8 - 配置与资产布局: 配置放哪、模型放哪、角色参考音频放哪？优先级序？
➡️ 推荐: `~/.config/say/config.toml`（XDG，engine/voice/speed/presets/fallback 开关）+ 环境变量覆盖（SAY_VOICE/SAY_SPEED/SAY_PRESET/SAY_ENGINE）+ 模型缓存 `~/.cache/say/models/`（可再生，下载脚本管理）+ 角色语音资产 `~/.local/share/say/voices/<character>/`（`ref.wav + ref.txt + meta.json`，人工采集高再获取成本，不入 cache 不入 repo）；优先级 **flag > env > config**（CLI 通行惯例）— 证据：用户 XDG 习惯；XDG 目录语义（cache 可再生/share 持久）；Gate 发现 3/9

❓ Q10 - 语言策略: 默认合成语言、文本检测与音色路由？(a) 英语默认，中文文本同嗓直读，不达标走通用 zh 预设 (b) 引擎级自动语言检测路由 (c) 同角色双语克隆嗓 + 音色级路由（CJK 正则一行判定，按语言选预设音色）
➡️ 推荐: (a) 为 v1 默认，(c) 的音色级路由作为预设配置能力顺带具备（config 可声明 zh 专用预设，无需自动检测）；(b) 否决 — 说话语言英语为主是用户明确指令；中英混合流量真实存在（agent 台词夹术语），其质量由 s-bench 混合短句实测覆盖，达标则同嗓直读成立，不达标则中文走通用 zh 预设（角色嗓在中文流量缺席 = 用户指令下的既定取舍，polaris 验收第二条以英语为口径）；引擎级自动路由复杂度不值，音色级路由只是预设选择，用户手动或 config 声明即可 — 证据：用户补充原话；ZipVoice/Kokoro v1.1 双语事实；Gate 发现 1

## 分期切片与依赖

```
s-bench(fail-fast) ──┬──▶ s-cli-core ──▶ s-voice ──▶ s-deploy
s-voicepack(fail-fast)┘（s-voice 双前置）
```

| 切片 | 优先级因素 | blocked_by | 验收口径 |
|---|---|---|---|
| s-bench：本机跑分与试听样本矩阵 | fail-fast | — | `node bench/run.mjs` 一键产出：延迟报告（冷/热 × sherpa-{matcha-zh, kokoro-v1.1-int8, ZipVoice-占位干音克隆} × mlx-Qwen3-TTS × en 短句 / en 长句 / zh 短句 / 中英混合短句）落 `docs/research/bench/`；每引擎×语言试听样本 wav；sherpa-onnx-node darwin-arm64 可行性矩阵 {kokoro, matcha, ZipVoice} × {Node 绑定, spawn 二进制} 分别出结论（不可行触发 Q7 退路）；ZipVoice 仅裁延迟与可行性，克隆质量归属不裁（占位音频限定高质量干音，弱证据不外用）；结论回写蓝图雾区 F2 |
| s-voicepack：角色参考音频采集与处理 | fail-fast | — | Lucy / D.Va / Frieren 三角色素材落 `~/.local/share/say/voices/<character>/`：`ref.wav`（10-30s，干音或经人声分离处理，动画素材需注明处理方式）+ `ref.txt`（素材精确转写）+ `meta.json`（来源/语言/许可注记：官方公开素材、本机个人使用）；采集脚本 `scripts/fetch-voices.mjs` 幂等可重跑（含代理/镜像通道注记）；英语素材优先（Lucy 美配/D.Va 美配），Frieren 日配或中配对照收录 |
| s-cli-core：say shim 核心 | coverage | s-bench | `node bin/say.js "text"` 神经音色出声（默认引擎按 s-bench 裁决接线）；合成执行器为三态可替换接口（进程内/子进程/daemon 预留）；文本规范化层（超短句 <5 字与超长 >400 token 行为有定义并有测试）；stdin/-v/-r/-o/未支持参数透传 /usr/bin/say；引擎失败回退系统 say + stderr 一行；配置优先级 flag > env > config；单测覆盖 config 解析/引擎选择/回退路径（引擎 mock）；并发双调用不崩溃 |
| s-voice：角色克隆音色包与预设机制 | coverage | s-bench, s-voicepack, s-cli-core | ZipVoice 克隆音色产出三角色×en/zh(+混合) 试听矩阵，HTML 简报呈现供用户裁决默认角色（克隆质量归属裁决点）；`SAY_PRESET=` 与 `--preset` 生效（音色×语速×引擎组合）；预设表含通用 en 音色与通用 zh 音色各 ≥1（polaris 验收第三条落点，样本入简报）；单测覆盖预设解析与优先级（flag > env > config） |
| s-deploy：安装接线与多 runtime 冒烟 | coverage | s-voice | 模型/语音资产下载脚本幂等（代理透传 + HF_ENDPOINT 镜像 fallback，冒烟注明所用网络通道）；link 脚本把 `say` 接入 ~/.local/bin；fresh 非交互 `zsh -c 'say "hello"'` 与 `bash -c` 冒烟出声；移除模型目录模拟失败 → 回退系统音色 + stderr 提示 + exit 0；README 快速上手；全局 CLAUDE.md 零改动验证 |

预算：max_slices = 5（取切片数），max_age_h = 48。

用户抉择点（按 D12 规范以完备上下文呈现，简报页 `docs/polaris-blueprints/tts-route-brief.html` 滚动更新）：① s-bench 完成通知——通用引擎延迟/质量数据 + 试听样本 + 推荐默认引擎；② s-voice 完成通知——三角色克隆试听矩阵 + 默认角色推荐（克隆质量归属裁决点）；③ awaiting-e2e——最终验收试听。

## 数据/模块模型

```
say/
├── bin/say                  # CLI 入口（Node，无扩展名 shebang）
├── src/
│   ├── config.ts            # XDG config.toml + flag/env 覆盖，优先级 flag > env > config
│   ├── normalize.ts         # 文本规范化层：超短句处理、长文分块、（引擎相关的）合并策略
│   ├── engines/
│   │   ├── index.ts         # 引擎注册表：name → adapter
│   │   ├── sherpa.ts        # kokoro/matcha/zipvoice 同宿主适配
│   │   ├── mlx.ts           # mlx-audio 子进程适配（--play 或管道 afplay）
│   │   └── system.ts        # /usr/bin/say 透传与回退
│   ├── executor.ts          # 合成执行器三态接口：in-process / subprocess / daemon（F2 触发只增实现）
│   ├── voices.ts            # 角色音色解析：~/.local/share/say/voices/<character>/{ref.wav,ref.txt,meta.json} → 引擎克隆参数
│   ├── speak.ts             # 编排：解析 → 规范化 → 选引擎/执行器 → 合成 → 播放/写文件 → 失败回退
│   └── player.ts            # afplay spawn；-o 时 PID 临时文件转写
├── bench/run.mjs            # s-bench 跑分器（保留为回归工具）
├── scripts/
│   ├── install-models.mjs   # 引擎模型下载（幂等，代理 + HF_ENDPOINT 镜像）
│   ├── fetch-voices.mjs     # 角色参考音频采集/分离/转写（幂等）
│   └── link.mjs             # PATH shadow 接线
└── test/                    # vitest（引擎 mock，不依赖模型文件）
```

关键数据：模型缓存 `~/.cache/say/models/<engine>/<model>/`（可再生）；角色语音资产 `~/.local/share/say/voices/<character>/`（`ref.wav + ref.txt + meta.json`，版权素材不入 repo）；配置 `~/.config/say/config.toml`（`engine` / `voice` / `speed` / `fallback = "system"` / `[presets.<name>]`）。

## 注册表/扩展点

* 引擎注册表（src/engines/index.ts）：新引擎 = 实现 adapter 接口 {speak, listVoices, isAvailable} + 登记一行；登记即接线（config `engine = "<name>"` 直接可用）
* 执行器三态接口（src/executor.ts）：进程拓扑维度的扩展点——daemon 化（F2）只增实现不改编排
* 角色音色注册表（~/.local/share/say/voices/ 目录扫描）：新角色 = 放入 ref.wav/ref.txt/meta.json，无需代码
* 预设注册表（config.toml `[presets.*]`）：预设 = 引擎+音色+语速组合，无需代码；音色级语言路由 = 声明 zh 专用预设（Q10 选项 c 的配置化形态）
* 通用音色枚举 = 模型缓存目录扫描，不硬编码音色表

## 决策日志

* D1：epic 方向由用户原话直接指定，本次选向未发生正交发散——如实记录，防后续循环误读
* D2：系统人设音色（Eddy/Flo zh_CN）不作 epic 终点，仅作对照基线与失败回退目标——可定制性与角色克隆验收信号系统 say 无法满足；用户试听若推翻，epic 缩为 CLAUDE.md 一行改动（触发条件见 F1）
* D3：兼容面 = `say <text>` 子集 + 常用 flag + 未支持参数透传（Q1）
* D4：默认引擎必须本地离线；云引擎只作显式配置的可选预设（Q4）
* D5：语气 = 配置预设（音色×语速×引擎），情绪引擎留扩展位（Q2）
* D6：部署 = PATH shadow `say` 于 ~/.local/bin，退路为独立命令名 + CLAUDE.md 一行（Q3）
* D7：引擎选型走基准测试裁决制：sherpa-onnx 为工程底座（通用音色 + ZipVoice 克隆同宿主），mlx+Qwen3-TTS 为中文质量挑战者（en-first 后权重下调）；s-bench 裁通用引擎延迟/质量，克隆质量归属裁决在 s-voice（真实素材后，Gate 发现 2）。**s-bench 已落地**：工程底座确定 = sherpa-onnx Node 绑定（六格可行性全验证，延迟数据见事实底座）；mlx-qwen3 延迟与 kokoro 同档但体量 1.9GB 且 zh 热态 MARGINAL——挑战者身份保留、不默认接线；默认嗓候选 = zipvoice 克隆嗓（若 s-voice 相似度获用户认可，短句热 2.4-2.6s 在预算内）或 kokoro en 嗓（通用兜底，en-short 热 1.59s 最快）
* D8：失败回退 /usr/bin/say，出声即 exit 0；并发无锁混叠（Q6）
* D9：实现栈 Node + 引擎适配器 + 执行器三态接口；sherpa-onnx-node 可行性按模型×通道矩阵由 s-bench 验证，退路 spawn C++ 二进制（Q7，Gate 发现 4）
* D10：语言策略——说话语言默认英语（用户明确指令），中文同嗓直读、混合短句质量 s-bench 实测；不达标则中文走通用 zh 预设（角色嗓缺席中文流量 = 用户指令下既定取舍）；音色级路由经预设配置具备，不做引擎级自动检测（Q10，Gate 发现 1 修订）
* D11：角色克隆 v1 路线 = ZipVoice 零样本（本地 CPU、sherpa 同宿主）；素材工程标准 = 干音 + 精确转写 + meta 溯源，存 `~/.local/share/say/voices/`；升级阶梯 GPT-SoVITS 微调 → ElevenLabs 云 → IndexTTS-2.5 情绪版，各留雾区触发条件；素材仅取官方公开语音、本机个人使用、不再分发（Q9，Gate 发现 3 修订）
* D12：决策呈现规范（源自用户流程补充）——Polaris 级决策以完备上下文呈现：HTML 决策简报（架构图 + 内嵌试听播放器 + 选项与推荐 + 高风险台账），不使用裸 Ask 快问；本 epic 三个用户抉择点见「分期切片」节。flow-polaris 技能优化建议已登记，epic 收尾时与用户确认后落技能
* D13：配置优先级 flag > env > config——CLI 通行惯例；Gate 发现 9 指出原 env 优先无反直觉场景辩护理由，反转
* D14：克隆路线 epic 级降级出口——三角色相似度全不获用户认可时：通用音色 CLI 照常交付（其余验收信号不受影响），polaris 验收第二条标记未达成并显式回报用户，升级阶梯（F3 本地微调 / F5 云克隆）交用户裁决；禁止把失败静默吸收进雾区

高风险决策台账（与用户既往表态存在张力，随简报供 review）：

* HR1（源自 D7/Q5）：收编现成 CLI（用户次优路线）被否——gensay 是该象限现成答案但 2★ 零社区验证 + 本地 provider 需 ~2GB PyTorch + 克隆能力未验证（其 chatterbox provider 为克隆向模型，但是否暴露参考音频接口未验，Gate 发现 6 修正）；sag 需付费云 key 违反 D4。本蓝图选择用户第三优先「套壳自建」（薄壳 + 引擎适配器），实质理由：失败回退/预设/透传/克隆四件套自建薄壳依赖面更小（sherpa 宿主 + afplay）。若用户倾向先试 gensay，s-bench 加测 chatterbox 克隆路径即可翻转
* HR2（源自 D6/Q3）：PATH shadow 全局劫持 `say`——符合用户首选偏好且多 runtime 自动受益，但影响所有调用方（含未知脚本）；透传 + 回退为缓解面。若用户不接受全局劫持，退路 (b) 已备

## 已否决路线

* 「维持系统 say 不动」：与用户明确不满冲突
* 「商业云 TTS API 直连 / sag 收编」：付费 + 联网 + 非官方依赖，违反 D4 离线可用性下限（sag/ElevenLabs 克隆保留为雾区 F5 云预设候选）
* 「edge-tts 作底座」：2024-2026 三次封禁事故，可用性押在上游心情上；仅作质量锚点与可选云预设
* 「收编 gensay」：见 HR1（设计被吸收为规格参照：接口复刻面/warm daemon/断网回退/LRU 缓存）
* 「Piper 路线」：中文仅 huayan 且社区差评，项目招募维护者中
* 「Coqui XTTSv2 / gtts / espeak-ng / flite」：口音/停更/机器人音质，全维度弱
* 「KittenTTS / Dia / OuteTTS」：无中文（且克隆能力缺失）
* 「v1 即上 GPT-SoVITS/IndexTTS-2.5 重克隆」：训练/GPU/许可成本与「即席短句说话」场景错配，留雾区 F3/F4 按触发升级（F3 触发即部署形态跃迁，代价已标注）
* 「引擎级自动语言检测路由」：复杂度不值；音色级路由经预设配置化具备（Q10）
* 「中文为主语言」：用户补充明确英语优先，中文仅质量达标时启用（D10）

## 遗留与雾区

* F1 系统 Enhanced/Premium 音色：GUI 手动下载（两种入口说法待验），触发条件 = 用户试听基线样本后想对比，或全线失败时的零代码保底
* F2 守护进程/warm daemon 模式：执行器三态接口已预留（D9），触发只增实现。**s-bench 已正式触发条件**（kokoro en-long 冷 11.1s、zipvoice en-long 冷 15.2s 均 >10s；spawn 通道热态全线 >3s）——但 v1 处置为「规范化层分块 + 顺序合成流水播放」：agent 主场景是短句（hot 1.6-2.6s 达标），长文本经分块后首包出声 <3s，体验目标即可达成；daemon 延后至分块流水仍不满足体验时实施（gensay daemon 与 sherpa 官方 server 建议为设计参照），实施时 kokoro/zipvoice 的 spawn 热态超标格全部转 PASS 预期
* F3 克隆质量升级——GPT-SoVITS 少样本微调：触发条件 = s-voice 三角色 ZipVoice 零样本相似度用户试听不认可（尤其 Frieren 跨语种克隆失败时）；触发即部署形态跃迁（重服务化、训练管线），代价显式告知用户后再动
* F4 情绪表现力引擎（IndexTTS-2.5 / Qwen3-TTS 情绪面）：触发条件 = 语气预设（D5）被用户判定不够
* F5 云预设（ElevenLabs 角色克隆 / edge-tts / sag）：触发条件 = 用户明确要求质量天花板且接受联网/付费，作为 config 可选 engine 接入；亦为 D14 降级出口的升级选项之一
* F6 跨机分发（npm 发布 / brew tap）：触发条件 = 用户想在其他机器使用
* F7 中文克隆音质：触发条件 = 用户提出中文说话需求且 ZipVoice zh 试听不达标，评估 Qwen3-TTS/edge-tts zh 预设
