# 代码库关注点（Concerns）

**分析日期：** 2026-09-19

## 已知陷阱

**int8 kokoro 权重经 Node 绑定产出全 NaN 静音（最高优先级陷阱）**
- 现象：同版本 int8 包经 `sherpa-onnx-node` 绑定的动态 onnxruntime 产出长度正常、内容全 NaN 的样本，退出码与时长都正常，最终交付一个静音文件；同版本静态二进制读同一份 int8 权重出声正常，缺陷在绑定的量化算子路径上
- 证据与防线：`src/engines/sherpa-binding.ts:31`（钉定 fp32 的注释，代价 326MB vs 114MB）、`src/engines/sherpa.ts:51`（`assertAudible` 样本层能量校验：全 NaN / 无能量即抛 EngineError 交回退层）、`scripts/lib/deploy-config.mjs:67`（int8 包不进安装清单，note 字段明确记录）、README.md:18、测试锁定 `test/sherpa.test.ts:237`（全 NaN 判死用例）
- 注意事项：任何引入 int8 权重、更换绑定版本或换 onnxruntime 的改动都必须重验能量；bench 跑分用的恰是 int8 包（`scripts/lib/deploy-config.mjs:68` 注明 int8 是 bench 资产），其延迟数字与运行时 fp32 不完全可比
- 反向注意：zipvoice 的 distill int8 权重出声正常，NaN 缺陷不在该路径（`src/engines/zipvoice-binding.ts:42` 注释，bench 与冒烟双证据），不要"一刀切"把 int8 全部排除

**sherpa-onnx-node 无类型声明且是 CJS 聚合导出**
- 现象：包内不带 .d.ts（仅 JSDoc），且 `await import("sherpa-onnx-node")` 的命名导出为 undefined，全部成员挂在 default 上
- 证据：`types/sherpa-onnx-node.d.ts:1`（手写最小声明，明确"不写 export class——那会让值导入通过类型检查却在运行时炸掉"）；`src/engines/sherpa-binding.ts:144` 取 `module.default`
- 注意事项：该声明只覆盖本仓实际用到的面，刻意不声明其余成员；用到新 API 时先补声明（`ruleFsts` 就是"包内 types.js 未列此键，native 实际接受"的实例，`types/sherpa-onnx-node.d.ts:52`）

**bin 入口必须是纯 JavaScript**
- 现象：Node 的类型擦除只按 .ts 后缀启用，无扩展名文件一律当 JS 解析，因此 `bin/say` 不能写 TypeScript
- 证据：`bin/say:2`（入口注释）、`tsconfig.json`（`allowImportingTsExtensions` + `erasableSyntaxOnly` + `noEmit`——运行时直接跑 .ts，不产构建产物）
- 连带约束：Node ≥ 22.18 是硬性运行时要求（`scripts/link.mjs:78` 在接线前检查 `node --version`）；`erasableSyntaxOnly` 禁用 enum/namespace/参数属性等需转换的语法，新代码只能用类型可擦除子集

**zipvoice 克隆链路加速请求会让 native 层永久挂起**
- 现象：实测 speed > 1 时 `generateAsync` 在 native 层挂起（推理线程空闲等不到返回），0.5/0.8/1.0 正常
- 防线：`src/engines/zipvoice-binding.ts:56`（`generationSpeedOf` 只放行 <1 的放慢请求，等于 1 或加速一律不下发，返回 null 即不下发 speed 键）+ 适配层警告忽略（`test/zipvoice.test.ts:110` 断言 stderr 含"加速"）
- 注意事项：这是钳制不是 bug，若上游绑定换版想要放开，必须先用探针重验；测试 `test/zipvoice.test.ts:171` 锁定安全域口径

**native 库直写 fd 2，JS 层重定向拦不住**
- 现象：sherpa native 推理绕开 `process.stderr` 直写描述符 2，加载模型每次吐一行上游词典警告，而 `say` 成功时应当静默
- 方案：`src/stderr.ts:34` `withStderrMuted` 在描述符层面把 fd 2 指向 /dev/null；原目标经 `/dev/fd/2` 重新 open 固定（Node 不暴露 dup2），depth 计数防重叠窗口互相踩（分块流水下合成与播放并行，窗口必然重叠）
- 注意事项：这是全局可变状态 + POSIX fd 语义依赖（`/dev/fd` 缺失的平台宁可多一行噪声也不吞错误）；`src/pipeline.ts:45` `settle` 特意等在飞的那块合成落地后才退出——遮罩窗口没收尾时写回退原因就是写进 /dev/null，原因行会凭空丢失。改动流水/退出路径时必须保持 settle 语义

## 技术债

**模块级 native 句柄与参考音频缓存，进程生命周期内不释放**
- 位置：`src/engines/sherpa-binding.ts:129`（`handles: Map<string, OfflineTtsInstance>` 模型句柄按规格缓存）、`src/engines/zipvoice-binding.ts:99-101`（`handles` + `waves` 参考音频 Float32Array 缓存，无条目上限）
- 影响：单次 CLI 调用进程随即退出，无实际问题；但 bench 的 node-worker 或未来常驻化（daemon）场景下，这些缓存只增不减，模型句柄（数百 MB 权重）与参考音频会持续驻留
- 修复时机：接线常驻执行器（`src/executor.ts:14` 的 daemon 分支目前抛 NotImplementedError，属预留扩展点）时一并设计逐出策略；bench 侧 `bench/types/sherpa-onnx-node.d.ts:33` 已注明 1.13.8 未暴露 free/release，句柄随 GC/进程退出释放

**sherpa-onnx-node 类型声明存在两份，需同步维护**
- 位置：`types/sherpa-onnx-node.d.ts`（src/test 消费：interface 形态、只声明 default 导出）与 `bench/types/sherpa-onnx-node.d.ts`（bench 消费：class 形态、多出 writeWave/extra）
- 影响：两份按消费面分治是刻意的（各自只声明用到的面，注释均写明），但同一 native 包的事实（如 ruleFsts 行为、CJS default 导出形态）分散两处；升级 sherpa-onnx-node 时容易只改一份
- 修复方向：升级依赖版本时以 node_modules 源码与 addon 二进制字符串实证（bench 那份注释的方法）逐份核对

**kokoro 103 音色 sid 表内嵌于源码**
- 位置：`src/engines/sherpa-voices.ts:10`（`KOKORO_VOICES` 103 项，下标即 sid；`KOKORO_VOICE_COUNT` 常量）
- 背景：voices.bin 只存风格嵌入不带名字，模型目录也没有名字清单，"按目录扫描"物理不可行，只能内嵌（文件头注释）
- 风险与防线：资产换版后 sid 错配表现为"能出声但是另一个嗓子"（越界 sid 被 native 静默落 sid 0，不报错）；运行期防线是 `assertSpeakerTable`（`src/engines/sherpa.ts:79`）用绑定返回的 numSpeakers 与表长交叉校验，错配即判死回退
- 修改注意：改表必须同时满足 numSpeakers 校验与 `test/sherpa-voices.test.ts`、`test/sherpa.test.ts:231` 的条数断言

**长文本延迟超标，常驻执行器未实现**
- 现状：kokoro/zipvoice/mlx 的 en-long 热态 9.98s/14.35s/9.12s 均超 10s 冷态线（FAIL），`bench/lib/verdict.mjs` 判据下的既有结论；三分之二的引擎长文本场景依赖分块流水（`src/pipeline.ts:137` 播块 i 合成块 i+1）缓解首包延迟
- 缓解与预留：`src/executor.ts:9` 三态执行器接口（进程内/子进程/常驻），daemon 分支显式抛 NotImplementedError 并注释触发条件；编排层只认 SynthesisExecutor，接线常驻不需要动引擎适配与编排
- 修复路径：bench 报告（`docs/research/bench/report.md`）的 F2 建议——模型载入摊薄到多次调用时再接线 daemon

## 模型资产：体积与缓存位置

**位置（运行时，`src/paths.ts:14` XDG 语义）：**
- 模型缓存：`~/.cache/say/models/`（`XDG_CACHE_HOME` 可整体重定向，安装与测试均依赖这一点）
- 角色克隆嗓：`~/.local/share/say/voices/<角色名>/`（ref.wav + ref.txt + meta.json 三件套）
- 配置：`~/.config/say/config.toml`

**体积：**
- 安装清单（`scripts/lib/deploy-config.mjs:51` `ASSETS`）：kokoro fp32 326MB（`model.onnx` 钉定 325,631,784 字节）+ matcha 76MB + vocos 22kHz 54MB + zipvoice int8 约 130MB + vocos 24kHz 54MB ≈ 760MB（README 口径）；bench 另需 int8 kokoro 与 mlx Qwen3（实测含工具包缓存共约 3.8G，`docs/reports/260919-s-bench-v2.md`）
- 字节钉定：GH Releases 资产不可变，`assessGroup`（`scripts/lib/deploy-config.mjs:119`）对关键文件校验精确字节数，不符即判残缺
- 安装脚本幂等且自愈：已就绪 skip、包在盘而清单未就绪先解包自愈、断点续传 `-C -`（完整包续传会 416，故残件先删再下，`scripts/install-models.mjs:105`）；解包验证后删除压缩包减半占地

**工程注意：**
- 模型与二进制不落 repo 内（`bench/lib/config.mjs:8` 注释）；`docs/research/` 下的大体积 wav/raw 证据不入库（被全局 gitignore 覆盖，仓库 85 个跟踪文件中无音频）
- 引擎目录名与必需文件清单在 `scripts/lib/deploy-config.mjs`（安装侧）与 `src/engines/*-binding.ts`（运行侧）各有一份，清单对齐靠约定；改目录名/文件清单必须两处同改（`scripts/install-models.mjs:2` 注明"清单对齐运行时 src/engines"）

## Licensing 注意

**matcha zh_baker 数据集非商用**
- 证据：README.md:54（"单女声，数据集非商用"）、`src/config.ts:28`（"matcha 单女声且数据集非商用，个人使用注记见蓝图"）、`scripts/lib/deploy-config.mjs:84`（资产 note）
- 影响：zh_baker 是内置预设 `zh`（`src/config.ts:30` `BUILTIN_PRESETS`）的中文默认嗓；本工具目前 `private: true` 仅本机使用无碍，一旦分发安装包或商用，zh 预设需要换嗓并同步改内置预设与测试

**角色克隆嗓素材（dva / lucy / frieren）**
- 采集脚本固定注记"官方公开素材，本机个人使用，不再分发"（`scripts/lib/pipeline.mjs:80`）
- meta.json 必填 `license_note` 字段（`scripts/lib/verify.mjs:16` `META_REQUIRED`），校验器强制角色包带许可注记——新增角色必须注记来源与许可；这些都是游戏/动漫角色的声线克隆，边界是本机个人使用，不可分发克隆产物

## 测试覆盖缺口

**scripts/lib 的 node:test 用例不在 pnpm test 内**
- `package.json` scripts 只有 `vitest run`；`scripts/lib/pipeline.test.mjs`、`verify.test.mjs` 用 node:test 编写且 vitest include 仅 `test/**/*.test.ts`——跑全量单测不会触及它们，需手动 `node --test scripts/lib/`
- 风险：采集/校验管线的回归（ffmpeg 参数、角色包校验）可能被漏跑；修复方向是给 package.json 加一个 `node --test scripts/lib/` 的 script 或并入 test 链

**无独立测试文件的源码**
- `src/index.ts`（main 组装）、`src/report.ts`、`src/errors.ts`、`src/executor.ts`（daemon 分支）、`src/engines/*-binding.ts`（native 绑定层，设计上由 bench 证据链与部署冒烟覆盖）
- 风险评估：多数经编排层测试间接覆盖；绑定层是唯一触 native 的位置，其回归依赖 bench `--verify` 对账与冒烟（`docs/research/deploy/report.md`），改动绑定层后应跑 bench 或冒烟而非只跑 vitest

**覆盖率工具未配置**
- vitest 无 coverage 配置，无阈值强制；测试质量靠接缝纪律（fake-host 模式）与行为契约描述约束

## 性能瓶颈

**afplay 每次启动约 1.0s 固定开销**
- 位置：`src/player.ts:6`（注释记录实测值）
- 影响：分块出声卡模式每块付一次；分块预算据此设定（首块 30 近似 token 换首次出声、后续放大到 160 摊薄开销，`src/normalize.ts:13`，预算增长倍率 2.5 由 RTF 0.4 下的不断流不等式推出）
- 改进路径：CoreAudio 直连可消掉该开销，但多一条 native 依赖面，当前判断为不值得（`src/player.ts` 注释）

**每调用重载模型权重（CLI 一次性进程的固有代价）**
- kokoro fp32 载入实测 0.69s 量级（`src/normalize.ts:16`）；mlx Qwen3 每调用重载 2GB 权重（bench 报告）
- 改进路径即上述 daemon 化

## 脆弱区

**`say -v ?` 清单解析与 macOS 输出格式耦合**
- 位置：`src/engines/system.ts:13`（正则 `VOICE_LINE` 以 locale 令牌为锚点反推名字边界，容忍音色名含空格与本地化括号）
- 风险：macOS 大版本改变 `say -v ?` 输出形态会使系统嗓开放集路由（`-v Tingting` 委派）静默退化为"全部交回配置引擎"——功能不炸但语义降级；无 locale/无注释的行按不可识别跳过是既定容错
- 安全修改：改解析先补 `test/sherpa.test.ts` 与 `test/zipvoice.test.ts` 中仿真的清单 stdout 用例

**同一模型实例上的并发合成无上游保证**
- 位置：`src/pipeline.ts:137` `playChunks` 播块 i 时合成块 i+1，同一 handles 缓存的模型句柄上两个并发 generate
- 现状：注释明示"实测安全：产物能量正常，总耗时短于顺序执行"（`src/pipeline.ts:135`）——是实测结论而非契约；升级 sherpa-onnx-node 或换模型后此假设需重验，`assertAudible` 是事后防线

**PATH shadow 接线的覆盖风险**
- 位置：`scripts/link.mjs`——把 `bin/say` 软链到 `~/.local/bin/say`，同名 shadow 系统 `/usr/bin/say`
- 防线：已指向本 shim 则 skip（幂等）；已存在非本 shim 的同名文件时拒绝覆盖，`--force` 才放行（`scripts/link.mjs:50`）；系统 say 始终可经绝对路径直呼
- 注意：`--force` 前核实目标；`bin/say` 依赖沿 realpath 解析回仓库根，仓库挪动/删除会使全局 say 失效

## 依赖风险

**sherpa-onnx-node ^1.13.8（`package.json`）**
- 风险：项目最大的单点依赖——int8 NaN 缺陷、CJS default 导出形态、zipvoice 加速挂起、numSpeakers 行为全部与该绑定版本耦合；升级既可能修复也可能引入同类问题
- 迁移注意：升级时按 bench 证据链重验（跑分 + 能量校验 + 克隆冒烟），`types/sherpa-onnx-node.d.ts` 与 `bench/types/sherpa-onnx-node.d.ts` 两份声明逐份核对

**typescript ^7.0.2（原生编译器线）**
- `noEmit` + `allowImportingTsExtensions` + Node 原生类型擦除的组合依赖较新的 TS 与 Node（≥22.18）；降级 Node 或 TS 任一侧都可能破坏"直接跑 .ts"的运行方式
