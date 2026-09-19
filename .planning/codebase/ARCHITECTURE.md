<!-- refreshed: 2026-09-19 -->
# 架构

**分析日期：** 2026-09-19

## 系统概览

macOS `say` 的神经网络 TTS 替代 shim：同名 CLI 经 PATH shadow 接管 `say` 调用，默认本地离线推理（sherpa-onnx 进程内），任何失败回退系统嗓，出声即 exit 0。

```text
┌────────────────────────────────────────────────────────────────────┐
│  调用方（agent / shell 脚本 / 人）                                   │
│  `say "text"` —— 经 ~/.local/bin/say 同名 shadow 系统 /usr/bin/say  │
└──────────────────────────────┬─────────────────────────────────────┘
                               ▼
┌────────────────────────────────────────────────────────────────────┐
│  CLI 入口与解析层                                                    │
│  `bin/say`（纯 JS shebang 入口） → `src/index.ts`（main）           │
│  `src/cli.ts`（parseArgv：识别 / 透传 / 用法错误三态）               │
└──────────────────────────────┬─────────────────────────────────────┘
                               ▼
┌────────────────────────────────────────────────────────────────────┐
│  编排层                                                             │
│  `src/speak.ts`（run：总编排）                                       │
│  `src/config.ts`（三层配置合并） · `src/normalize.ts`（分块）        │
│  `src/pipeline.ts`（单块 / 流水分块合成）                            │
│  `src/fallback.ts`（回退链） · `src/delivery.ts`（交付与退出码）     │
│  `src/engines/index.ts`（路由仲裁与注册表）                          │
└───────┬──────────────────────┬─────────────────────┬───────────────┘
        ▼                      ▼                     ▼
┌───────────────────┬──────────────────────┬─────────────────────────┐
│ sherpa 引擎        │ zipvoice 引擎         │ system 引擎              │
│ `src/engines/     │ `src/engines/        │ `src/engines/system.ts` │
│  sherpa.ts`       │  zipvoice.ts`        │ subprocess 执行器        │
│ in-process 执行器  │ in-process 执行器     │ spawn /usr/bin/say      │
└───────┬───────────┴──────────┬───────────┴─────────────────────────┘
        ▼                      ▼
┌───────────────────┬──────────────────────┐
│ sherpa-binding    │ zipvoice-binding     │   Host（唯一 OS 边界）
│ sherpa-onnx-node  │ 同一 native 绑定      │   `src/host.ts`
│ 惰性动态 import    │ 克隆参数注入          │   spawn / fs / env /
└───────────────────┴──────────────────────┘   stderr / 时钟 / 临时名
```

## 术语表

| 术语 | 含义 | 关键位置 |
|------|------|----------|
| 音色（voice） | 引擎内的嗓音标识，三个来源：sherpa 内嵌表（kokoro 103 嗓 + matcha `zh_baker`）、zipvoice 角色克隆嗓、系统嗓开放集 | `src/engines/sherpa-voices.ts`、`src/voices.ts` |
| 角色（character） | `~/.local/share/say/voices/<角色名>/` 下的三件套（`ref.wav` + `ref.txt` + `meta.json`），目录即注册表，放文件即上新嗓，无需改代码；语言变体名为 `<角色>-<variant>` | `src/voices.ts` |
| 预设（preset） | 音色 × 语速 × 引擎的一套命名组合；内置 `en` / `zh` 两条 | `src/config.ts` `BUILTIN_PRESETS` |
| 透传（passthrough） | 未登记进支持面的 argv 整条原样转交 `/usr/bin/say`，stdio inherit，退出码原样继承 | `src/cli.ts`、`src/speak.ts` |
| 回退（fallback） | 神经引擎不可用 / 合成失败 / 产出静音时转 system 引擎重说，出声即算成功（exit 0），stderr 留一行原因 | `src/fallback.ts` |
| shadow | `scripts/link.mjs` 把 `bin/say` 软链到 PATH 前置的 `~/.local/bin/say`，同名遮蔽系统 say；系统 say 仍可绝对路径直呼 | `scripts/link.mjs` |
| chunkable | 引擎适配器的能力位：能否把裸 PCM 样本交回编排层（决定分块流水是否可用） | `src/types.ts` `EngineAdapter` |
| 执行器（executor） | 「合成在哪个进程里发生」的进程拓扑抽象，三态：in-process / subprocess / daemon | `src/executor.ts` |
| Host | 一切触达操作系统动作的接口，编排层只依赖它，单测注入假实现 | `src/host.ts` |
| wpm | 用户面语速单位（words per minute），锚点 175 wpm = macOS say 默认语速（实测逐位一致） | `src/config.ts` `DEFAULT_RATE_WPM`、`src/engines/sherpa.ts` `wpmToSpeed` |

## 调用面兼容策略（say shim 与透传回退）

兼容面是「say 的子集 + 其余原样转交」，不逐项复刻 man say。

1. **入口**：`bin/say` 保持纯 JavaScript（无扩展名文件被 Node 当 JS 解析，类型擦除只按 `.ts` 后缀启用），只负责调 `src/index.ts` 的 `main()` 并设退出码。
2. **解析层只识别不裁决**（`src/cli.ts` `parseArgv`）：受支持面由 `SUPPORTED_FLAGS` 表定义——`-v/--voice`、`-r/--rate`、`-o/--output-file`、`-f/--input-file`、`--preset`。解析结果 `CliRequest` 是 argv 的忠实映射，`-f` 与位置参数谁胜等取舍留给编排层。
3. **三种解析结局**（判别联合）：
   - `kind: "speak"` —— 走本工具合成通道；
   - `kind: "passthrough"` —— 表外选项**整条**透传（含 `--progress -v` 这种缺值长尾）；`-v ?` 列表模式也强制透传（列表要直达终端，进采集通道会变成无声、无列表、exit 0 的静默空操作）；
   - `kind: "usage-error"` —— 显式意图坏值（如 `-r abc`）在解析层判用法错误，退出码 2。
4. **透传执行**（`src/speak.ts` `passthrough`）：`host.spawn(SYSTEM_SAY_BIN, argv, { stdio: "inherit" })`，进度条 / 交互高亮 / `-v ?` 列表直达终端，退出码原样继承，不走本工具的退出码口径。
5. **正文来源裁决**（`src/speak.ts` `resolveText`）：位置参数胜过 `-f`（与 macOS say 实测一致），`-f -` 与无正文读 stdin。
6. **PATH shadow 接线**（`scripts/link.mjs`）：幂等软链 `bin/say` → `~/.local/bin/say`；已指向本 shim 则 skip，非本 shim 占位需 `--force` 才覆盖。

## 引擎注册表与三态执行器

**EngineAdapter 契约**（`src/types.ts`）：`name` / `chunkable` / `ownsVoice?` / `isAvailable(voice)` / `listVoices()` / `speak(text, opts)`。关键设计点：

- `chunkable` 是进程内引擎对编排层的承诺：声明可分块就必须交回 `pcm` 形态裸样本（违者被 `src/pipeline.ts` `chunkableViolation` 判失败进回退）。
- `ownsVoice` 是音色名仲裁能力位：引擎声明自己认领哪些名字（sherpa 查内嵌表、zipvoice 查角色目录在盘）。
- `isAvailable` 按**待用音色**判定而非按引擎整体：一个引擎挂多套权重（kokoro / matcha），只装一套时不连坐另一套的音色。

**执行器三态**（`src/executor.ts` `defineExecutor` + `src/types.ts` `ExecutorKind`）：

| 态 | 现状 | 使用者 |
|----|------|--------|
| `in-process` | 已实现：绑定就是本进程函数调用，起子进程只会白付一次模型加载 | sherpa、zipvoice |
| `subprocess` | 已实现：无可进程内调用的绑定，拓扑上只能子进程 | system（spawn `/usr/bin/say`，正文走 stdin 防 ARG_MAX） |
| `daemon` | 占位：`defineExecutor("daemon", …)` 抛 `NotImplementedError`，常驻化落地时只增实现不改编排 | 无 |

**注册表**（`src/engines/index.ts`）：`createRegistry` 以 name 索引、`all()` 保留登记序（音色认领仲裁按登记序逐个询问）。`createDefaultRegistry` 登记顺序：sherpa → zipvoice → system；「登记即接线」——实现 `EngineAdapter` 后在此加一行，`engine = "<name>"` 配置与 `SAY_ENGINE` 立即可切。

**绑定缝**：native 触达收在唯一位置——`SherpaSynth` / `ZipvoiceSynth` 函数类型（`src/engines/sherpa-binding.ts`、`src/engines/zipvoice-binding.ts`）。适配器只认签名，单测注入假实现覆盖全部路由与校验分支。绑定内部：惰性 `import("sherpa-onnx-node")`（走系统嗓的调用不为绑定付解析失败面）、模型句柄按规格缓存（分块复用同一份权重）、`withStderrMuted` 包住模型加载与推理。

## 音色路由仲裁

`src/engines/index.ts` `routeEngine`，音色空间三分：

1. 显式点名 system 引擎 → 原样下传（系统嗓是开放集，语义由 say 自己兜）；
2. 其余引擎按登记序 `ownsVoice` 认领，认领即归属（内嵌表 / 角色目录）；
3. 认领失败后查系统嗓清单（`say -v ?` 解析，`src/engines/system.ts` `parseSayVoiceList`），命中即委派——`-v Tingting` 这类迁移调用不因默认引擎是神经引擎而失效；
4. 谁也不认领 → 交回配置引擎报「未登记」并触发回退：`-v nosuch` 得到系统嗓 + 一行原因 + exit 0，而不是被系统 say 静默忽略成默认嗓。

## 失败回退链（出声即 exit 0）

**退出码口径**（`src/report.ts`）：`0` = 出过声或有产物（回退成功同样是 0）；`1` = 全程无声且无产物；`2` = 用法错误；透传路径原样继承 `/usr/bin/say` 退出码。

**链路**（`src/fallback.ts`）：

1. `speakWith` 把合成失败收敛为 `Attempt` 值（`{ ok: false, reason }`），不抛错——合成失败是回退的触发条件而非异常；
2. `attemptSpeak` 依次判：引擎未登记 → 音色不可用（缺资产报精确清单）→ 合成抛错；
3. `recover` 回退到 system 引擎：`SAY_FALLBACK=off` 可关；不回退到自己（重试只多一行原因不多一分出声机会）；回退前写 `say: fallback: <原因>`（`FALLBACK_PREFIX` 固定前缀，脚本可稳定 grep「这次不是主引擎出的声」）。

**分块路径的回退细分**（`src/pipeline.ts`）：

- 一块都没出过声 → `recoverWhole` 按全文回退（无重复内容）；
- 已播出前面的块 → `recoverTail` 只把剩余块交回退引擎（听众已经听过前半段，重播全文比漏后半段更糟），退出码仍按「出过声即 0」；
- 提前退出前 `settle` 等在飞的下一块落地（fd 2 遮罩窗口没收尾时原因行会写进 /dev/null；被丢弃的推理照样占墙钟，计入耗时摘要）。

**静音防线**：引擎层样本校验（`src/engines/sherpa.ts` `assertAudible` / `assertSpeakerTable`，`src/engines/zipvoice.ts` `assertAudible`）——上游量化权重会返回长度正常、内容全 NaN 的静音样本，只看退出码与时长会判成功；样本全 NaN / 无能量 / 说话人数与内嵌表错配一律判失败交给回退层，不交付静音冒充成功。

**已知 native 陷阱的防御**（写在绑定层）：

- kokoro int8 权重经 Node 绑定产出全 NaN → 安装清单钉定 fp32（`scripts/install-models.mjs`，磁盘 326MB 换出声）；
- zipvoice 克隆链路 `speed > 1` 会让 `generateAsync` 在 native 层永久挂起 → `generationSpeedOf` 只放行 `<1` 的放慢请求，加速请求写 stderr 说明并忽略（`src/engines/zipvoice.ts`）。

## 文本规范化与长文分块流水播放

**规范化**（`src/normalize.ts`）：`normalizeText` 折叠横向空白但保留换行（换行是句边界）；`approxTokens` 近似计价——CJK 一字一 token、拉丁四字符一 token，给分块一个稳定量纲。

**分块预算**（实测依据写死在注释里）：整段 ≤ 400 近似 token 直通不分块；首块预算 30（换首次出声约 3.5s）、每交付一块预算 ×2.5 逐步放大、封顶 160（摊薄 afplay 约 1s 的固定启动开销）。按句边界切（`splitSentences`，句尾标点集合 + 小数点保护 + 连续标点算同一句尾），单句超预算按字符硬切。

**流水执行**（`src/pipeline.ts` `playChunks`）：出声卡模式下**播块 i 的同时合成块 i+1**——合成快于播放（实测 RTF 0.37–0.54），流水起来后整段耗时趋近播放时长。当前块 `await` 与下一块 `pending` promise 并行；同一模型实例上的两个并发合成实测安全。

**落盘模式**（`mergeChunks`）：`-o` 目标是单个文件，早写一块不能早交付，故全部块合成完、校验块间采样率一致（不齐拼接会整段变调）后拼接封一个 wav。

**是否分块由 chunkable 决定**（`src/speak.ts`）：能交回裸样本的引擎才分块；system 引擎自己写盘或直推声卡，块间无从拼接，切开只会多出边界停顿。

## 交付（delivery）

`src/delivery.ts` 把 `AudioOut` 三形态变成交付物：

- `pcm`（进程内引擎）：编排层封 WAV 容器（`src/wav.ts` 自研 16-bit 单声道编码器）→ 落盘模式写 `target.<pid>.tmp` 后**原子改名**到目标（读者要么见旧文件要么见完整新文件）；出声卡模式写 `say-<pid>[-<块序号>].wav` 暂存名后 `afplay` 播放再清理（PID + 块序号防并发调用互相覆盖 / 截断）；
- `file`（system 引擎落盘）：改名到目标；
- `device`（system 引擎直推声卡）：已出声，无事可做。

清理是幂等意图：残留临时文件只是脏，清理失败不盖掉真正的失败原因；写盘失败顺手清临时名，否则反复失败会攒孤儿 `.tmp`。

## 三层预设与配置解析

**层序**（`src/config.ts` `resolveConfig`）：每个维度独立按 `flag > env > config > preset` 取值；**预设值是最低一档显式层**——手动指定的 voice/speed/engine 永远胜过预设值，预设是「一套默认组合」不是更高优先级的覆盖。预设名本身按 `--preset > SAY_PRESET > config preset` 选。

| 维度 | flag | env | config（`~/.config/say/config.toml`） | 预设字段 |
|------|------|-----|---------------------------------------|----------|
| 引擎 | — | `SAY_ENGINE` | `engine` | `engine` |
| 音色 | `-v` | `SAY_VOICE` | `voice` | `voice` |
| 语速 | `-r`（wpm） | `SAY_SPEED` | `speed` | `speed` |
| 预设名 | `--preset` | `SAY_PRESET` | `preset` | — |
| 回退 | — | `SAY_FALLBACK`（system/off） | `fallback` | — |
| 调试 | — | `SAY_DEBUG=1` | — | — |

**坏值的两种口径**：config / env 层坏值一律降级默认值 + warnings 数组（返回而非直接打印，保持解析纯函数可测）——配置 typo 不该让「永远能出声」瘫痪；flag 坏值在 `src/cli.ts` 判用法错误退出码 2——那是本次调用的显式意图，应当吵闹地失败。空串与 null/undefined 同义（shell 里 `export SAY_VOICE=` 是取消覆盖）。

**XDG 落点**（`src/paths.ts` `resolvePaths`，env 显式传入可被测试用临时 HOME 覆盖）：

- 配置：`$XDG_CONFIG_HOME`（默认 `~/.config`）/`say/config.toml`
- 模型：`$XDG_CACHE_HOME`（默认 `~/.cache`）/`say/models`
- 角色嗓：`$XDG_DATA_HOME`（默认 `~/.local/share`）/`say/voices`

**解析两层分离**（`src/config.ts`）：`parseConfigFile` 只做语法层（smol-toml，未知键静默忽略向前兼容），类型校验归 `resolveConfig` 语义层，各自可独立测。预设表合并时坏条目降级警告不拖垮其余预设；config presets 与内置表（`BUILTIN_PRESETS`：`en` → af_maple/sherpa、`zh` → zh_baker/sherpa）合并。

## 组件职责

| 组件 | 职责 | 文件 |
|------|------|------|
| 入口 | 纯 JS shebang，调 main 设退出码 | `bin/say` |
| 组装 | 建 Node host、真实路径与注册表，执行一次调用 | `src/index.ts` |
| argv 解析 | 识别 / 透传 / 用法错误三态，只识别不裁决 | `src/cli.ts` |
| 总编排 | 取正文 → 配置合并 → 规范化分块 → 路由 → 合成 → 交付 | `src/speak.ts` |
| 配置 | 三层合并、预设、坏值降级 | `src/config.ts` |
| 分块 | 规范化、近似 token、句切分、预算分块 | `src/normalize.ts` |
| 流水编排 | 单块 / 流水分块、中途回退、耗时归账 | `src/pipeline.ts` |
| 回退 | Attempt 值化、system 引擎兜底 | `src/fallback.ts` |
| 交付 | WAV 封容器、暂存播放、原子改名、退出码 | `src/delivery.ts`、`src/wav.ts`、`src/player.ts` |
| 路由与注册表 | 音色认领仲裁、引擎登记 | `src/engines/index.ts` |
| 引擎适配 | sherpa / zipvoice / system 三适配器 | `src/engines/sherpa.ts`、`src/engines/zipvoice.ts`、`src/engines/system.ts` |
| native 绑定 | 唯一触 sherpa-onnx-node 的位置、句柄缓存、fd 2 遮罩 | `src/engines/sherpa-binding.ts`、`src/engines/zipvoice-binding.ts` |
| 音色登记 | 内嵌 103 嗓表、角色目录解析 | `src/engines/sherpa-voices.ts`、`src/voices.ts` |
| OS 边界 | spawn / fs / env / stderr / 时钟 / 临时目录 | `src/host.ts` |
| fd 2 遮罩 | 遮住 native 库直写描述符的日志 | `src/stderr.ts` |
| 报告 | 退出码常量、`say:` 前缀、debug 摘要 | `src/report.ts` |
| 错误类型 | EngineError / PlaybackError / NotImplementedError | `src/errors.ts` |
| 执行器 | 三态拓扑占位 | `src/executor.ts` |
| 共享契约 | 领域类型集中防循环引用 | `src/types.ts`、`src/deps.ts` |
| 部署 | 模型资产幂等安装、PATH shadow 接线 | `scripts/install-models.mjs`、`scripts/link.mjs`、`scripts/lib/*` |
| 跑分 | 8 通道 × 4 文本 × 冷热延迟矩阵 | `bench/run.mjs`、`bench/lib/*` |

## 数据流

### 主请求路径（`say "text"`）

1. `bin/say` → `main()` 组装 host / paths / registry（`src/index.ts:56`）
2. `parseArgv` 识别为 speak 请求（`src/cli.ts:51`）
3. `resolveText` 取正文 → `normalizeText` → 空文本短路 exit 0（`src/speak.ts:30`、`src/speak.ts:82`）
4. `loadConfigFile` + `resolveConfig` 三层合并，warnings 写 stderr（`src/speak.ts:86`）
5. `routeEngine` 音色仲裁定引擎（`src/engines/index.ts:48`）
6. `chunkText` 分块（chunkable 引擎且超阈值）（`src/speak.ts:103`）
7. 单块走 `speakOnce`；多块按 delivery.target 走 `playChunks`（流水）或 `mergeChunks`（合并）（`src/pipeline.ts:168`）
8. 块内：`attemptSpeak` → 引擎 `speak` → 执行器 → 绑定（进程内）或 spawn（system）；失败 `recover` 回退 system（`src/fallback.ts:20`）
9. `deliver` / `deliverAndExit`：封 wav → 播放或原子改名 → 退出码（`src/delivery.ts:101`）
10. `writeDebug`（`SAY_DEBUG=1`）写一行时序摘要，返回退出码（`src/report.ts:27`）

### 透传路径（表外 flag）

1. `parseArgv` 返回 `passthrough`（`src/cli.ts:82`）
2. `passthrough` 以 stdio inherit spawn `/usr/bin/say`，退出码原样返回（`src/speak.ts:17`）

### 状态管理

无持久状态。进程内可变状态仅两处模块级缓存：native 模型句柄 Map（`src/engines/sherpa-binding.ts`、`zipvoice-binding.ts` `handles`）与参考音频样本缓存（zipvoice-binding `waves`）——一次调用内分块复用，避免重复付加载开销。用户状态全在文件系统（XDG 三落点 + 角色目录即注册表）。

## 关键抽象

**Host 接口**：一切触达 OS 的动作（env / pid / tmpDir / now / writeStderr / spawn / fileExists / listDirEntries / 读写删改名 / readStdin）收在 `src/host.ts`。编排层只依赖接口，单测注入 `test/fake-host.ts` 的 `createFakeHost` 即可覆盖回退、透传、临时名与退出码语义，不碰真实模型与用户目录。

**判别联合**：`CliRequest`（kind）、`AudioOut`（type）、`Attempt` / `Availability` / `ConfigFileParse` / `TextSource`（ok）——「结果或原因」一律值化返回而非抛错。

**EngineAdapter + SynthesisExecutor 双轴**：适配器轴（换模型 / 换后端）与执行器轴（换进程拓扑）正交，各扩各的。

## 入口点

| 入口 | 触发 | 职责 |
|------|------|------|
| `bin/say` | PATH 上的 `say` 命令 | CLI 主入口 |
| `scripts/install-models.mjs` | 手动安装 | 幂等下载五组引擎资产（`--verify` 只审计） |
| `scripts/link.mjs` | 手动接线 | PATH shadow 软链（`--dry-run` / `--bin-dir` / `--force`） |
| `scripts/fetch-voices.mjs` | 可选采集 | 三角色参考音频资产管线 |
| `bench/run.mjs` | 跑分 | `--setup` / `--bench` / `--report` / `--verify` |

## 架构约束

- **单线程 + 单事件循环**：进程内推理是异步 native 调用；流水播放依赖「同一模型实例两个并发合成安全」的实测结论（`src/pipeline.ts`）。
- **全局可变状态**：`src/stderr.ts` 的 fd 2 遮罩（`original` + `depth`）——深度计数保证重叠窗口（流水下合成与播放并行各开遮罩）不会把 /dev/null 装回去；两个绑定层的 `handles` / `waves` Map。
- **平台绑定**：macOS 专属（`/usr/bin/say`、`/usr/bin/afplay`、`/dev/fd/2`）；Node ≥ 22.18（类型擦除按后缀启用）；Apple Silicon。
- **类型循环防线**：跨模块领域契约集中在 `src/types.ts`（文件头注释明示此意图），`RunDeps` 单独成模块避免编排层与 CLI 入口互相 import。
- **资产契约**：内嵌音色表与权重换版强耦合，运行期用绑定的 numSpeakers 交叉校验（`assertSpeakerTable`），错配即判死。

## 反模式（本库明令避免的做法）

### 编排层直接触 OS

**现象**：绕过 Host 直接 `spawn` / 读 `process.env` / 读真实用户目录。
**后果**：单测必须 mock 模块或触碰真实资产；`vitest.config.ts` 用 `HOME=/nonexistent-say-test-home` 把任何此类泄漏变成显式失败。
**正确做法**：一切经 `Host` 接口（`src/host.ts`），测试注入 `createFakeHost`（`test/fake-host.ts`）。

### 静音产出冒充成功

**现象**：只看退出码与样本时长判断合成成功。
**后果**：量化权重不兼容时交付全 NaN 静音文件，「无声但 exit 0」比失败更难发现。
**正确做法**：出声与否在样本层验证（能量 / NaN / 说话人数，`src/engines/sherpa.ts` `assertAudible`），验不过判失败交回退层。

### 解析层做取舍

**现象**：argv 解析时顺手裁决 `-f` 与位置参数谁胜、未登记音色怎么路由。
**后果**：解析结果不再是 argv 的忠实映射，无法独立断言。
**正确做法**：解析层只识别（`src/cli.ts`），裁决归编排层（`src/speak.ts`）。

### 遮罩窗口嵌套踩踏

**现象**：每次 stderr 遮罩都备份「当时的 fd 2」。
**后果**：重叠窗口（流水播放）收尾时把 /dev/null 装回去，整个进程 stderr 静默丢失，连回退原因都看不见。
**正确做法**：第一次遮罩固定真实目标常驻描述符 + 深度计数归零才恢复（`src/stderr.ts`）。

## 错误处理

**策略**：可预期失败值化 + 回退，编程错误不 catch。

- **类型分工**（`src/errors.ts`）：`EngineError` = 引擎侧可预期失败（走回退）；`PlaybackError` = 出声环节失败（合成已产出，与合成失败分开决策）；`NotImplementedError` = 拓扑占位。编程错误不该被 catch 成静默降级。
- **值化**：`speakWith` 把抛错收敛为 `Attempt`；`Availability` / `ConfigFileParse` / `DeliveryResult` 同型。
- **包装保留语义**：绑定层 `if (error instanceof EngineError) throw error` 后再包一层带引擎名的消息（`src/engines/sherpa-binding.ts:162`）。
- **降级**：配置坏值 → 默认值 + warnings；目录不存在 → 空注册表（`src/host.ts` `listDirEntries`）；清理失败 → 吞掉（ENOENT 即达成目的）。
- **统一出口**：`fail()` 写 `say: ` 前缀一行返回 EXIT_FAILURE（`src/report.ts:21`）。

## 横切关注点

**stderr 约定**：`say: ` 前缀 = 本工具自己的输出（脚本可稳定 grep）；`say: fallback: ` = 回退原因；`say: debug: ` = 时序摘要。native 库直写 fd 2 绕开 process.stderr，只能用描述符级遮罩（`withStderrMuted`，`src/stderr.ts`）保证成功时静默。

**日志**：运行时无文件日志；部署 / 跑分的真实执行落 `docs/research/deploy/raw-log.jsonl` 证据链（append-only，幂等 skip 不入日志，报告数字可从 log 全格重算对账）——`scripts/lib/deploy-config.mjs` `logEvent`、`bench/lib/log.mjs`。

**校验**：样本能量 / 说话人数校验（引擎层）、采样率一致性（拼接前）、chunkable 承诺校验（编排层）。

---

*架构分析：2026-09-19*
