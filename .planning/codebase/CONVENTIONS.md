# 编码约定

**分析日期：** 2026-09-19

以下约定全部从实际代码提取（`src/` 20 个文件、`test/` 17 个文件、`scripts/` 与 `bench/` 的 .mjs）。本仓库无 ESLint / Prettier / Biome 配置——约定靠 `tsconfig.json` 严格开关、代码评审与注释文化维持，新代码照既有文件风格写即可。

## 语言与模块形态

- **TypeScript 严格上限**（`tsconfig.json`）：`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax` + `erasableSyntaxOnly` + `noImplicitOverride`。target/lib `es2023`。
- **ESM**：`package.json` `"type": "module"`；node 内建模块一律 `node:` 前缀（`node:child_process`、`node:fs/promises`）。
- **导入带 `.ts` 后缀**：`allowImportingTsExtensions` + `noEmit`——`import { run } from "./speak.ts"`。这是硬约定，全库无一例外。
- **`import type` 强制**（`verbatimModuleSyntax`）：类型导入与值导入分开写（如 `src/speak.ts` 头部）。
- **no any**：全 `src/` 零处 `any`（含注释）。边界不 trusted 数据（TOML 原值、JSON meta）声明为 `unknown` 后用 `typeof` / `Array.isArray` 收窄——范例 `src/voices.ts` `variantsOf`、`src/config.ts` `mergePresetTables`。
- **可擦除语法**（`erasableSyntaxOnly`）：不用 enum / namespace / 参数属性，判别联合 + 工厂函数替代。
- **无构建步骤**：`noEmit`，Node 22.18+ 直接跑 `.ts`；`bin/say` 入口因此必须保持纯 JS（无扩展名文件不被类型擦除覆盖）。

常用命令：

```sh
pnpm test          # vitest run（全量测试）
pnpm typecheck     # tsc --noEmit
```

## 命名模式

**文件**（`src/` 平铺，全小写）：
- 连字符分词：`sherpa-binding.ts`、`sherpa-voices.ts`、`zipvoice-binding.ts`、`speak-chunked.test.ts`
- 领域名词单文件单主题：`cli.ts`、`config.ts`、`delivery.ts`、`fallback.ts`、`normalize.ts`、`pipeline.ts`
- 桶文件固定叫 `index.ts`：`src/index.ts`（公共面 + main）、`src/engines/index.ts`（引擎登记与路由）
- 类型集中文件叫 `types.ts`；测试接缝叫 `fake-host.ts`

**函数**（动词前缀语义化）：
- `create*` 工厂：`createRegistry`、`createSherpaEngine`、`createNodeHost`、`createFakeHost`
- `define*` 声明式构造：`defineExecutor`
- `parse*` / `resolve*` 解析与裁决对：`parseArgv`（识别）vs `resolveConfig` / `resolveText` / `routeEngine`（裁决）
- `assert*` 失败即抛的校验：`assertAudible`、`assertSpeakerTable`
- `is*` 谓词：`isSherpaVoice`、`isAbsent`、`looksLikeFlag`
- `*Of` 从已知量派生：`messageOf`、`kokoroSidOf`、`cacheKeyOf`、`generationSpeedOf`、`stagingPath`
- `with*` 包裹执行：`withStderrMuted`

**常量**：SCREAMING_SNAKE_CASE 且集中模块顶部——`EXIT_OK`、`FALLBACK_PREFIX`、`CHUNK_BUDGET`、`SHERPA_ENGINE`、`DEFAULT_RATE_WPM`。对外常量经桶文件导出。

**类型**：PascalCase；「结果或原因」用判别联合，判别字段统一 `kind`（进程形态）、`type`（产出形态）、`ok`（成败）：`CliRequest`、`AudioOut`、`Attempt`、`Availability`、`ConfigFileParse`。

**注释**：全中文；错误消息、vitest describe/it 描述也全中文。

## 注释规范（只解释 Why）

注释密度极高，且几乎全部解释**隐含假设、实测依据与折衷**，不复述代码做了什么。新代码必须维持这一密度与取向：

- **实测依据带数字**：`src/config.ts` ——「175 是本机实测的 macOS say 默认语速：同一文本 `say` 与 `say -r 175` 产出时长逐位相同（3.664354s）」；`src/normalize.ts` ——「实测 30 近似 token 约 15 个英文词、4.7s 音频，合成 1.86s 叠加模型载入 0.69s」。
- **native 陷阱取证**：`src/engines/sherpa-binding.ts` ——「同版本 int8 包经本绑定的动态 onnxruntime 产出全 NaN 静音…缺陷在绑定的量化算子路径上」；`src/engines/zipvoice-binding.ts` ——「实测 speed > 1 会让 generateAsync 在 native 层永久挂起（探针取证：0.5/0.8/1.0 正常出声…）」。
- **权衡句式**（宁可 X 也不 Y / 代价是 Z 换来 W）：`src/wav.ts` ——「钳制而非回绕：越界样本若按位截断会翻相」；`src/engines/system.ts` ——「正文走 stdin 而非 argv：长文本会撞 ARG_MAX」。
- **为什么这一层做这件事**：`src/speak.ts` ——「引擎对空文本会抛错而非产出静音，与 macOS `say ""` 的静默成功对齐只能在这一层短路」。
- **禁止**：开发追踪标记（阶段 / 编号 / 交付引用）、外部链接式溯源（如「见 ADR-X」）。需要溯源时用自己的话重述 why。

文件头三斜线式块注释说明模块职责与设计动机，范例：`src/normalize.ts`、`src/engines/sherpa-voices.ts`、`scripts/link.mjs`。

## Import 组织

1. `node:` 内建模块
2. 三方依赖（仅 `smol-toml`、类型-only 的 `sherpa-onnx-node`）
3. 本仓库相对导入（`../` 上行、`./` 同级），全部带 `.ts` 后缀
4. `import type` 与值 import 分组书写

类型组织：跨模块共享契约集中 `src/types.ts`（文件头注明「避免 engines 桶与 speak 之间的类型循环引用」）；依赖注入容器形状单独 `src/deps.ts`。无路径别名。

## 错误处理模式（fallback 语义）

本库错误处理的公理：**合成失败是回退的触发条件，不是异常**。

1. **错误类型分工**（`src/errors.ts`）：`EngineError`（引擎侧可预期失败）／`PlaybackError`（出声环节失败，与合成失败分开决策）／`NotImplementedError`（拓扑占位）。编程错误不 catch 成静默降级。
2. **值化不抛**：跨层传递的成败一律判别联合值——`Attempt { ok, out | reason }`（`src/fallback.ts`）、`Availability`、`ConfigFileParse`、`DeliveryResult`、`TextSource`。`speakWith` 是标准样板：try/catch 后返回 `{ ok: false, reason: messageOf(error) }`。
3. **包装保留语义**：绑定层重抛既有 `EngineError`、其余包装成带引擎名的 `EngineError`（`src/engines/sherpa-binding.ts:161-164`）。
4. **降级 + 警告**：config/env 层坏值降级默认值，原因收集进 `warnings: string[]` 返回（保持解析纯函数可测），由编排层统一打印（`src/config.ts`、`src/speak.ts` `loadConfigFile`）。
5. **幂等清理**：`removeFile` 吞 ENOENT；`discard` 吞一切清理失败——「残留的临时文件只是脏，清理失败不该盖掉真正的失败原因」（`src/host.ts`、`src/delivery.ts`）。
6. **退出码口径**（`src/report.ts`）：0 = 出过声或有产物；1 = 全程无声无产物；2 = 用法错误；透传原样继承。失败行统一经 `fail()` 出口（`say: ` 前缀 + 返回码）。
7. **防御性校验先行**：`assertAudible` / `assertSpeakerTable` 在交付前判死静音与错配；`routeEngine` 拿不准的名字交回配置引擎报精确原因。

## stderr 约定（引擎日志不污染调用方）

- **`say: ` 前缀**：本工具全部自我输出走 `host.writeStderr`，失败行经 `fail()` 统一加前缀（`src/report.ts`）——脚本可稳定 grep。
- **`say: fallback: `**：回退原因行固定前缀 `FALLBACK_PREFIX`（`src/fallback.ts:9`），调用方据此识别「这次不是主引擎出的声」；恰好一行的形态有测试锁定（`test/fallback.test.ts`）。
- **native 噪声遮罩**：sherpa-onnx 直写 fd 2 绕开 `process.stderr`，JS 重定向拦不住；`withStderrMuted`（`src/stderr.ts`）在描述符层面把 fd 2 指向 /dev/null，深度计数兼容重叠窗口，成功时保证静默。所有模型加载与推理调用必须包在遮罩内（见两个 binding）。
- **采集 vs 直达**：本工具自己的合成调用用 capture 模式（子进程 stderr 收集进错误消息）；透传用 inherit 模式（进度条 / `-v ?` 列表直达终端，`src/speak.ts:17`、`src/host.ts` `StdioMode`）。
- **debug 摘要**：`SAY_DEBUG=1` 时 `writeDebug` 输出一行 `say: debug: engine=… voice=… chunks=… synth=…ms play=…ms total=…ms`（`src/report.ts`）。

## 函数与模块设计

- **函数小而单职责**，`src/` 无超 300 行文件（最大 `src/config.ts` 206 行）；超长逻辑按「解析 / 裁决 / 执行」分层拆。
- **参数用 options 对象**：`SherpaEngineOptions`、`ZipvoiceEngineOptions`、`FakeHostOptions`；布尔开关用具名常量与注释（`NUM_THREADS`、`MAX_NUM_SENTENCES`）。
- **工厂 + 闭包**代替 class：`createSherpaEngine` 返回 `EngineAdapter` 对象字面量，私有助手（`requirementOf`、`missingFiles`）闭包捕获；全库无 class 定义（仅 errors 三个 Error 子类）。
- **readonly / as const**：内嵌表 `readonly string[]`、格式参数 `as const`（`src/engines/system.ts` `WAVE_FORMAT_ARGS`）、返回字面量 `as const`。
- **判别联合 API**：多态数据（`AudioOut`）配收窄处理，`Extract<…>` 取分支（`src/speak.ts:30`）。
- **桶文件公共面**：`src/index.ts` 集中 re-export 全公共 API + `main`；`src/engines/index.ts` re-export 引擎工厂与常量（「登记即接线」注释标明扩展点）。
- **接缝即函数类型**：native 触达面收敛为 `SherpaSynth` / `ZipvoiceSynth` 类型别名，适配器经构造参数注入——扩展新引擎 = 新 binding + 新 adapter + 注册表加一行。
- **索引访问**：`noUncheckedIndexedAccess` 下用 `??` 兜底（`chunks[0] ?? text`）、已校验处 `!` 断言（`src/normalize.ts` 循环内 `text[index]!`，紧跟注释说明不死循环保证）。

## 测试约定（垂直切片 TDD）

- **框架**：vitest 5（`vitest.config.ts`），测试集中 `test/` 目录，命名 `<主题>.test.ts` 与被测模块对应（`cli.test.ts` ↔ `src/cli.ts`）；scripts 的 .mjs 测试同目录放置（`scripts/lib/verify.test.mjs`）。
- **接缝泄漏防线**：`vitest.config.ts` 设 `HOME=/nonexistent-say-test-home`——任何用例若触到真实 `~/.cache/say` 即失败。
- **不用 `vi.mock`**：模块级 mock 拦不到被测模块内部的静态 import；一律经 `Host` 接口注入 `createFakeHost`（`test/fake-host.ts`），native 绑定经 `SherpaSynth` 签名注入假实现。范例组装见 `test/fallback.test.ts` `invoke`。
- **中文行为句命名**：describe 是场景（「引擎不可用时回退到系统嗓」），it 是行为契约（「模型缺失即回退，出声因此 exit 0」「音色名与语速原样带进回退调用，用户意图不在回退中丢失」）。
- **断言行为后果而非实现细节**：回退是否发生以「系统嗓被调起」为准（`fellBack` 辅助，`test/fallback.test.ts:56`）；stderr 形态精确断言（一行、前缀、点名缺失文件）。
- **假时钟注入**：耗时字段要可断言就注入 `now` / `advance`（`test/speak-chunked.test.ts`），「默认恒 0 会让耗时字段全是零，测不出摘要行是否真的在计时」。
- **垂直切片流程**：每个切片是完整可运行、可测试的功能（解析→裁决→执行同切片交付），禁止跨 layer 切片（先写库再写接口最后页面式）；切片收尾全量 `pnpm test` + `pnpm typecheck`，全量测试加超时。

## Where to Add New Code

- **新引擎适配器**：`src/engines/<name>.ts` 实现 `EngineAdapter`（`src/types.ts`）+ 如需 native 则 `src/engines/<name>-binding.ts` 定义 `Synth` 函数类型 → `src/engines/index.ts` `createDefaultRegistry` 登记一行 → `test/<name>.test.ts`。
- **新配置维度**：`src/types.ts` 加字段 → `src/config.ts` `KNOWN_KEYS` + `resolveConfig` 加 pick 层 → `src/README`/`README.md` 配置表同步 → `test/config.test.ts`。
- **新 CLI flag**：`src/cli.ts` `SUPPORTED_FLAGS` 登记规范名 → `CliRequest` speak 分支加字段 → `src/speak.ts` flags 透传给 `resolveConfig` → `test/cli.test.ts`。
- **新音色表**：静态嗓进 `src/engines/sherpa-voices.ts`（保持 sid 注释四重核对约定）；角色嗓直接放 `~/.local/share/say/voices/<名>/` 三件套，无需改代码。
- **新测试**：`test/<主题>.test.ts`，复用 `createFakeHost`；禁止 `vi.mock`、禁止触真实资产与用户目录。

---

*约定分析：2026-09-19*
