# 代码库结构

**分析日期：** 2026-09-19

仓库根：`/Users/lionad/Github/Lionad-Morotar/say`（macOS `say` 的神经网络 TTS 替代，Node/TypeScript CLI，ESM，`"type": "module"`，无构建产物——源码 `.ts` 由 Node 原生类型擦除直接执行）。

## 目录布局

```
say/
├── bin/
│   └── say                  # CLI 入口 shim（纯 .js，动态 import src/index.ts）
├── src/                     # 主源码（TS，19 个顶层模块 + engines/ 子域）
│   └── engines/             # 引擎实现（注册表 + 三引擎 + 绑定层）
├── test/                    # vitest 单测（17 个 .test.ts + fake-host.ts，镜像 src 命名）
├── scripts/                 # 运维脚本（.mjs，Node 直跑，不经 TS 编译）
│   └── lib/                 # 脚本共享库（含 node:test 单测 *.test.mjs）
├── bench/                   # 跑分器（.mjs）
│   └── lib/                 # 跑分逻辑（engines/ 为各引擎跑分通道）
├── types/                   # 第三方模块类型补充（手写 .d.ts）
├── docs/                    # 项目文档（blueprints/reports/reviews/tdd/research）
├── zRefs/                   # 调试参考区（第三方源码 symlink、probe 探针，不进 git）
├── .nsl/                    # 编排状态与切片 changelog（gitignore）
├── .flow/                   # flow 工具元数据（meta.yml）
├── .vscode/                 # 编辑器配置
├── package.json             # bin: say → ./bin/say；scripts: test / typecheck
├── tsconfig.json            # noEmit、strict 全开、allowImportingTsExtensions
└── vitest.config.ts         # include: test/**/*.test.ts，HOME 隔离防接缝泄漏
```

## 目录职责详解

### `src/` — 主源码（扁平模块 + 一个子域）

| 模块 | 职责 |
|------|------|
| `src/index.ts` | 全仓唯一对外桶文件 + `main()`：组装真实 Host/Paths/Registry 并调 `run()`（`src/index.ts:56`） |
| `src/cli.ts` | `parseArgv()`：argv → `CliRequest`（零 src 内依赖，纯函数） |
| `src/config.ts` | `parseConfigFile()`（smol-toml 解析）、`resolveConfig()` 三层合并（flag > env > toml > 默认）、`BUILTIN_PRESETS` 内置预设表 |
| `src/speak.ts` | `run()` 顶层编排：argv → config → `routeEngine()` → 分块 → pipeline → 退出码 |
| `src/pipeline.ts` | `speakOnce()` / `speakChunked()`：单块合成与流式分块合成播放的核心循环 |
| `src/delivery.ts` | `deliver()` / `deliverAndExit()`：播放或写 `-o` 文件（PID 临时名 + 原子改名）、`stagingPath()`、`startTiming()` |
| `src/fallback.ts` | `attemptSpeak()` / `recover()`：引擎失败后回退 system 的策略（`FALLBACK_PREFIX = "fallback: "`） |
| `src/normalize.ts` | 文本规范化、`splitSentences()`、`chunkText()`（阈值 400 token、首块预算 30） |
| `src/voices.ts` | 克隆嗓角色解析：`splitVoiceName()`（`角色@变体` 语法）、`resolveCharacterVoice()`、`transcriptOf()` |
| `src/executor.ts` | `defineExecutor()`：in-process / subprocess / daemon 三态执行器的统一构造器 |
| `src/host.ts` | `createNodeHost()`：进程/文件系统接缝（spawn、readFile、rename、tmpdir），`SYSTEM_SAY_BIN` |
| `src/paths.ts` | `resolvePaths()`：XDG 风格路径解析（`~/.cache/say` 模型资产、`~/.config/say` 配置） |
| `src/player.ts` | `playFile()`：经 `/usr/bin/afplay` 播放 WAV |
| `src/report.ts` | 退出码常量（`EXIT_OK/FAILURE/USAGE`）、`fail()`、`writeDebug()`、`Outcome` 类型 |
| `src/stderr.ts` | `withStderrMuted()`：合成期间临时静默 stderr（native 库噪声抑制） |
| `src/wav.ts` | `encodeWav()`、`concatSamples()`：PCM 样本 → WAV 字节 |
| `src/errors.ts` | `EngineError` / `NotImplementedError` / `PlaybackError` + `messageOf()` |
| `src/types.ts` | 全部共享类型：`EngineAdapter`（核心引擎抽象，`src/types.ts:44`）、`Host` 依赖的 `EnvMap`、`AudioOut`、`ResolvedConfig` 等（纯类型，无运行时代码） |
| `src/deps.ts` | `RunDeps`：`run()` 的依赖注入接口（host + paths + registry + sayBin） |

### `src/engines/` — 引擎子域

| 模块 | 职责 |
|------|------|
| `src/engines/index.ts` | 子域桶：`createRegistry()` / `createDefaultRegistry()` / `routeEngine()`（音色名仲裁）+ 三引擎工厂 re-export；**新引擎在此登记一行即接线**（`src/engines/index.ts:69`） |
| `src/engines/sherpa.ts` | sherpa 引擎（kokoro/matcha 神经嗓）：`createSherpaEngine()`、`wpmToSpeed()`、`DEFAULT_VOICE = "af_maple"` |
| `src/engines/sherpa-binding.ts` | sherpa native 绑定封装：模型目录/必需文件常量、`synthesizeWithBinding`（可注入的 `SherpaSynth` 函数类型） |
| `src/engines/sherpa-voices.ts` | 内嵌音色表：`KOKORO_VOICES`（103 个）、`MATCHA_VOICES`、`isSherpaVoice()` 认领判断 |
| `src/engines/zipvoice.ts` | zipvoice 克隆嗓引擎（三角色）：`createZipvoiceEngine()` |
| `src/engines/zipvoice-binding.ts` | zipvoice 绑定封装：模型常量、`ZipvoiceSynth` 可注入合成函数 |
| `src/engines/system.ts` | 系统 say 引擎：`createSystemEngine()`、`parseSayVoiceList()`（`say -v '?'` 输出解析） |

模式：每个引擎是「适配器（`<name>.ts`）+ 绑定层（`<name>-binding.ts`）」两件套，绑定层的合成函数以函数类型（`SherpaSynth` / `ZipvoiceSynth`）暴露，测试注入 fake 而不触 native。

### `test/` — 单测（vitest）

- 镜像 `src/` 命名：`test/normalize.test.ts` ↔ `src/normalize.ts`，`test/sherpa.test.ts` ↔ `src/engines/sherpa.ts`（引擎测试直接用平铺文件名，不加 `engines-` 前缀）。
- 编排级测试按行为拆分而非按文件：`speak.test.ts`（系统嗓闭环/配置优先级）、`speak-chunked.test.ts`（分块流水）、`speak-sherpa.test.ts`（神经嗓端到端）、`fallback.test.ts`（回退矩阵）。
- `test/fake-host.ts`：`createFakeHost()` 假 Host 实现（86 行），记录 spawn 调用（`SpawnRecord`），是全部不触真实进程的测试的公共桩。
- `test/config.test.ts` 与 `test/presets.test.ts` 同测 `src/config.ts`，按「配置解析」与「预设机制」分文件。
- 未直接镜像的模块：`host.ts`（经 fake-host 反向消费）、`pipeline.ts` / `index.ts`（经 speak-* 覆盖）、`report.ts` / `executor.ts`（薄文件，随调用方覆盖）。

### `scripts/` — 运维脚本（`.mjs`，shebang 直接跑）

- `scripts/install-models.mjs`：模型资产幂等安装/`--verify` 审计。
- `scripts/fetch-voices.mjs`：角色参考音频采集管线入口（下载→人声分离→转写→验证→冒烟）。
- `scripts/link.mjs`：PATH shadow 接线（`bin/say` 链入 `~/.local/bin` shadow 系统 `/usr/bin/say`）。
- `scripts/lib/`：脚本共享库——`deploy-config.mjs`（资产清单）、`manifest.mjs`（角色清单）、`pipeline.mjs`（纯命令构造函数）、`verify.mjs`（资产达标判定）、`config.mjs` / `log.mjs`（证据链日志）。
- `scripts/lib/*.test.mjs` 用 **node:test + node:assert**（非 vitest），如 `scripts/lib/verify.test.mjs:2`；vitest 只收 `test/**/*.test.ts`（见 `vitest.config.ts:4`）。
- 证据链契约：真实执行落 `docs/research/<topic>/raw-log.jsonl`，报告数字只从日志聚合。

### `bench/` — 跑分器（`.mjs`）

- `bench/run.mjs`：一键入口，四种模式 `--setup` / `--bench` / `--report` / `--verify`。
- `bench/lib/`：`channels.mjs`（跑分矩阵定义）、`runner.mjs` / `exec.mjs` / `sample.mjs`（执行与采样）、`assets.mjs`（资产落地）、`verdict.mjs` / `report.mjs` / `verify.mjs` / `log.mjs` / `config.mjs`。
- `bench/lib/engines/`：每个引擎一个跑分通道——`say.mjs`（系统基线）、`sherpa-spawn.mjs` / `sherpa-node.mjs` / `node-worker.mjs`（同一引擎三种调用面）、`mlx.mjs`、`sherpa-specs.mjs`。
- `bench/types/sherpa-onnx-node.d.ts`：跑分器自己的类型补充副本（与 `types/` 下的主副本独立）。

### `types/` — 第三方类型补充

- `types/sherpa-onnx-node.d.ts`：`declare module "sherpa-onnx-node"` 最小环境声明。该包不带 .d.ts 且是 CJS 聚合导出（成员挂 default），故只声明默认导出，只覆盖本仓实际用到的面（`types/sherpa-onnx-node.d.ts:1`）。**新用到 sherpa API 时在此补声明**。

### `docs/` — 项目文档

- `docs/polaris.md`、`docs/polaris-blueprints/`：路线蓝图（如 `tts-route.md`）。
- `docs/reports/`、`docs/tdd/`：切片级报告与 TDD 文档（`YYMMDD-s-<slug>.md` 命名）。
- `docs/reviews/`：代码评审存档（`YYMMDD-<slug>/prompt.md` + `review-<model>.md`）。
- `docs/research/`：调研报告（`YYYY-MM-DD-<slug>.md`）；`raw-log.jsonl` 证据链也落此（`voice-matrix/samples/` 被 gitignore）。

### `zRefs/` — 调试参考区（不进 git）

- `zRefs/sherpa-onnx-node`、`zRefs/mlx-audio-0.5.4`：第三方库源码 symlink（用于调试三方实现）。
- `zRefs/kokoro/`：音色 sid 元数据；`zRefs/probe/`：一次性探针脚本（`p*.mjs`、`acc-*.sh`，stderr 行为/延迟/并发等实测）。

## 模块间 import 关系

分层单向，无环。`.ts` 扩展名显式写出（`allowImportingTsExtensions`），一律相对路径（无路径别名）。

```text
bin/say ──► src/index.ts（桶 + main）
                │
                ▼
        src/speak.ts（编排）◄── test/*.test.ts 直接 import 各层
                │
   ┌────────────┼────────────┬──────────────┐
   ▼            ▼            ▼              ▼
src/cli.ts  src/config.ts  src/pipeline.ts  src/fallback.ts
（零内依赖） （smol-toml）   │    │             │
               │           ▼    ▼             ▼
               │    src/delivery.ts   src/engines/index.ts
               │           │         （注册表 + 路由）
               │           │             ├─► engines/sherpa.ts ──► sherpa-binding.ts（sherpa-onnx-node）
               │           │             ├─► engines/zipvoice.ts ─► zipvoice-binding.ts
               │           │             └─► engines/system.ts（spawn 系统 say）
               │           │                     │
               ▼           ▼                     ▼
        src/voices.ts / src/executor.ts / src/player.ts / src/stderr.ts
                │
                ▼
   底层：src/host.ts（接缝）· src/paths.ts · src/report.ts · src/wav.ts ·
         src/normalize.ts · src/errors.ts · src/types.ts（纯类型顶点）· src/deps.ts
```

要点：

- **依赖顶点**是 `src/types.ts`（纯类型）与 `src/errors.ts`（无依赖），被所有层引用。
- **唯一外部运行时依赖**只有 `smol-toml`（`src/config.ts:1`）与 `sherpa-onnx-node`（仅出现在两个 `-binding.ts` 内，引擎适配器不直接 touch native）。
- **接缝即测试点**：`Host` 接口（`src/host.ts:29`）抽象进程与文件系统；`SherpaSynth` / `ZipvoiceSynth` 函数类型抽象 native 合成。测试经 `test/fake-host.ts` + 注入 fake synth 覆盖全部编排逻辑，`vitest.config.ts:8` 甚至把 `HOME` 设为 `/nonexistent-say-test-home` 强制隔离。
- `src/engines/index.ts:69` 的 `createDefaultRegistry` 是引擎装配唯一位置：实现 `EngineAdapter` 后在此加一行即可被 `config` 的 `engine = "<name>"` 与 `SAY_ENGINE` 切换。

## 命名规范

**文件：**
- `src/`、`test/` 内一律单词或 kebab-case 小写：`speak.ts`、`sherpa-binding.ts`、`sherpa-voices.ts`、`fake-host.ts`。
- `src/` 与 `test/` 用 `.ts`（Node 原生类型擦除直跑）；`scripts/`、`bench/` 用 `.mjs`（纯 JS 运维工具链）。
- 测试文件 = 被测模块名 + `.test.ts`（vitest）或 `.test.mjs`（node:test，仅 scripts/lib）。
- 入口文件：`index.ts`（桶）、`run.mjs`（跑分入口）、`bin/say`（无扩展名，注释说明 Node 只按 `.ts` 后缀启用类型擦除，见 `bin/say:2`）。

**函数：**
- 工厂 `createXxx`：`createRegistry`、`createSherpaEngine`、`createNodeHost`、`createFakeHost`。
- 解析/构造 `parseXxx` / `resolveXxx` / `buildXxx`：`parseArgv`、`resolveConfig`、`resolvePaths`。
- 其余动词开头 camelCase：`deliver`、`playFile`、`encodeWav`、`routeEngine`。
- 可注入接缝命名为 `xxxSynth` 函数类型 + `synthesizeWithBinding` 实现。

**常量与类型：**
- 模块级常量 SCREAMING_SNAKE_CASE：`DEFAULT_ENGINE`、`EXIT_OK`、`KOKORO_VOICES`、`FALLBACK_PREFIX`。
- 类型/接口 PascalCase，抽象接缝用单数名词：`EngineAdapter`、`Host`、`RunDeps`、`SpeakContext`、`Outcome`。
- 判别联合用于错误/结果面：`Availability = { ok: true } | { ok: false; reason }`、`Attempt`、`ConfigFileParse`（见 `src/types.ts:21`、`src/fallback.ts:6`）。

**注释：** 中文，解释 why（隐含假设、仲裁规则、接缝泄漏判定），不叙述做了什么；关键仲裁如 `src/engines/index.ts:37` 的音色归属四分规则有完整段注释。

## 桶文件（index.ts）组织方式

- 全仓仅两个桶：`src/index.ts`（对外 API）与 `src/engines/index.ts`（引擎子域）。
- `src/index.ts` 按模块分组 re-export 全部公共符号（含 `export type * from "./types.ts"` 整组类型导出，`src/index.ts:52`），仅追加一个 `main()` 做真实依赖组装——桶内不写业务逻辑。
- `src/engines/index.ts` 除 re-export 外承载子域逻辑（注册表、路由、默认装配），是「桶 + 模块」混合体。
- 其余模块点对点互相 import，无中间桶；子域内部文件不绕过 `engines/index.ts` 直接被外层引用的只有类型（如 `test/fallback.test.ts:3` 从 `src/engines/sherpa.ts` 取 `SherpaSynth` 类型）。

## 在哪里加新代码

**新引擎（如云端 TTS / daemon）：**
1. 实现：`src/engines/<name>.ts`（+ 需要时 `<name>-binding.ts`），实现 `src/types.ts:44` 的 `EngineAdapter`。
2. 登记：`src/engines/index.ts` 的 `createDefaultRegistry` 加一行 + re-export 工厂。
3. 音色认领：实现 `ownsVoice?.()`（可选方法）参与 `routeEngine` 仲裁。
4. 测试：`test/<name>.test.ts`，注入 fake synth 与 `createFakeHost`。

**新 CLI flag：**
1. 解析：`src/cli.ts` 的 `CliRequest` + `parseArgv()`。
2. 合并：`src/config.ts` 的 `FlagOverrides` / `resolveConfig()`（保持 flag > env > toml 优先级）。
3. 消费：`src/speak.ts` 组装 `SpeakOptions` 下传。

**新文本处理规则（规范化/分块）：** `src/normalize.ts`（纯函数），配套更新 `test/normalize.test.ts`。

**新运维/安装脚本：** `scripts/<动词-名词>.mjs` + 共享逻辑进 `scripts/lib/`；真实执行落 `docs/research/<topic>/raw-log.jsonl`（证据链契约）；配套 `scripts/lib/*.test.mjs` 用 node:test。

**新跑分通道：** `bench/lib/engines/<name>.mjs` + 在 `bench/lib/channels.mjs` 登记。

**新第三方类型缺口：** 只补 `types/sherpa-onnx-node.d.ts`，用到才声明，防止声明与实现漂移。

**测试放哪：** vitest 用例一律 `test/<模块>.test.ts`；脚本纯函数用例放 `scripts/lib/*.test.mjs`（node:test）。单测禁止触碰 `~/.cache/say` 与 `~/.config/say`（`vitest.config.ts:7` 视为接缝泄漏）。

## 特殊目录

**`zRefs/`：** 调试参考区（三方源码 symlink、探针脚本）。Generated: 否。Committed: 否（全局 gitignore，见 `.gitignore` 中 `nsl 编排状态` 条目之外的用户级规则）。

**`.nsl/`：** nsl 编排状态 + 切片 changelog 分片（`changelog.d/s-*.md`、`chain/`）。Generated: 是（工具生成 + 人工撰写混合）。Committed: 否（`.gitignore:2`）。

**`docs/research/voice-matrix/samples/`：** 试听矩阵音频产物。Generated: 是。Committed: 否（`.gitignore:9`）。

**`node_modules/`、`dist/`：** 常规忽略；本仓无构建步骤，`dist/` 仅预留。

---

*结构分析：2026-09-19*
