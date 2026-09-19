# 技术栈（STACK）

**分析日期：** 2026-09-19

## 概览

macOS `say` 的神经网络级 TTS 替代：纯 Node/TS CLI，无构建步骤（Node 原生类型擦除直接运行 `.ts`），本地离线推理走 sherpa-onnx 绑定，任何失败回退系统 `/usr/bin/say`。零运行时框架依赖——`dependencies` 只有推理绑定与 TOML 解析两个包。

## 语言与运行时

**语言：**

- TypeScript（`src/**/*.ts`、`test/**/*.ts`）：strict 全开，以 `.ts` 后缀直接运行，无编译产物
- JavaScript（`scripts/**/*.mjs`、`bin/say`、`bench/*.mjs`）：部署与基准脚本保持 `.mjs`，不参与 tsc 检查

**运行时：**

- Node ≥ 22.18（README 记录实测 22.22；本机实测 v22.22.1）。22.18 起 Node 默认启用类型擦除（type stripping），这是无构建直接运行 `.ts` 的前提——`bin/say` 首行注释明确依赖该能力（「Node 的类型擦除只按 .ts 后缀启用，无扩展名文件一律当 JS 解析」）
- ESM：`package.json` 声明 `"type": "module"`

**包管理器：**

- pnpm（lockfile `pnpm-lock.yaml`，lockfileVersion 9.0；本机实测 pnpm 10.33.2）
- `package.json` 未声明 `packageManager` 字段，无 `.nvmrc` / `.node-version`，Node 版本要求只记录在 README

## 核心依赖及选型原因

**dependencies（运行时仅两个）：**

- `sherpa-onnx-node` ^1.13.8 — 全部神经 TTS 推理的绑定层（kokoro / matcha / zipvoice 三类模型共用）。选型要点与接缝处理：
  - 包内不带类型声明且是 CJS 聚合导出（`await import()` 的成员全挂 `default`），仓内自维护最小环境声明 `types/sherpa-onnx-node.d.ts`，只声明实际用到的面，避免声明与实现漂移
  - 惰性加载：走系统嗓的调用不为绑定付解析成本（`src/engines/sherpa-binding.ts:143`、`src/engines/zipvoice-binding.ts:122`），加载失败转成 `EngineError` 进回退链
  - 模型句柄按规格缓存，一次调用内分块合成复用同一份权重（`src/engines/sherpa-binding.ts:129`）
- `smol-toml` ^1.8.0 — 解析 `~/.config/say/config.toml`（`src/config.ts:1`），轻量零依赖 TOML 解析器，配 XDG 配置层

**devDependencies：**

- `typescript` ^7.0.2 — 只做类型检查（`tsc --noEmit`），不参与构建产物
- `vitest` ^5.0.1 — 测试运行器
- `@types/node` ^26.6.1 — Node 类型面

**刻意不存在的依赖：** 无 bundler（无 esbuild/rollup）、无 lint/format 配置（未检测到 eslint / biome / prettier）、无 CI 配置（未检测到 `.github/workflows`）、无额外 CLI 参数解析库（调用面解析手写在 `src/cli.ts`）。

## 开发命令

```sh
pnpm test        # vitest run（一次性跑完，非 watch）
pnpm typecheck   # tsc --noEmit
```

**tsconfig.json 关键项**（与「Node 原生跑 .ts」强配套，新增代码必须遵守）：

- `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitOverride`、`verbatimModuleSyntax`
- `erasableSyntaxOnly`：只允许可被类型擦除的语法——禁止 enum / namespace / 参数属性等需要转译的特性
- `allowImportingTsExtensions` + `moduleResolution: "bundler"` + `noEmit`：import 必须带 `.ts` 后缀（如 `src/index.ts` 里的 `./engines/index.ts`）
- `types: ["node"]`；include 范围为 `src/`、`test/`、`types/`、`vitest.config.ts`（`scripts/`、`bench/` 不在检查范围）

**vitest.config.ts 要点：** 只收集 `test/**/*.test.ts`，node 环境；测试全局注入 `HOME=/nonexistent-say-test-home`——任何用例触到真实 `~/.cache/say` 或 `~/.config/say` 即为接缝泄漏，新用例禁止绕过该隔离。

## 模型资产与安装脚本

**`scripts/install-models.mjs`**（清单与路径助手在 `scripts/lib/deploy-config.mjs`）：

- 幂等可重跑：清单齐全且钉定字节吻合的资产打印 `skip`，缺失才下载；`--verify` 只审计不下载，有缺项 exit 1
- 资产落地 `~/.cache/say/models/`，根目录可经 `XDG_CACHE_HOME` 整体重定向（冒烟与干净安装演练不触真实缓存）
- 清单共 5 组资产（`deploy-config.mjs` 的 `ASSETS`）：
  - `kokoro-multi-lang-v1_1`（fp32，model.onnx 钉定 326MB）——**权重钉定 fp32**：int8 的 kokoro 包经 Node 绑定的动态 onnxruntime 产出全 NaN 静音，不进安装清单
  - `matcha-icefall-zh-baker` + `vocos-22khz-univ.onnx`（中文嗓及配套 vocoder）
  - `sherpa-onnx-zipvoice-distill-int8-zh-en-emilia`（零样本克隆，int8 在该路径出声正常）+ `vocos_24khz.onnx`（与 matcha 的 22kHz vocoder 不通用）
- 就绪判定契约：文件存在 + 钉定字节数吻合（GitHub Releases 资产不可变，字节不符即残缺）；目录项（`espeak-ng-data`）按 `isDirectory` 兜底
- 下载走 `curl` 子进程：`-f -L -C -` 断点续传、`--retry 2`，透传 `HTTPS_PROXY`/`HTTP_PROXY`；HF 源资产支持 `HF_ENDPOINT` 镜像 fallback（默认 hf-mirror.com，当前清单无 HF 源）
- 自愈路径：压缩包在盘而清单未就绪（上次解包中断）→ 直接补解包；包损坏 → 删掉重下（完整包续传会 416）；解包验证后删压缩包省一半占地
- 证据链：真实下载/解包/接线各落一行 JSONL 到 `docs/research/deploy/raw-log.jsonl`（gitignored）；幂等 skip 不入日志；`proxy` 字段只记 `set`/`unset` 不记值（可能带凭证）
- `checkNpmDeps` 只提示 `node_modules` 缺项不代装——`pnpm install` 永远是 README 第一层

**`scripts/fetch-voices.mjs`**（可选）：角色克隆嗓（dva / lucy / frieren）参考音频的采集管线，产物放 `~/.local/share/say/voices/<角色名>/`（`ref.wav` + `ref.txt` + `meta.json` 三件套，无需改代码）。

## PATH shadow 接线机制

**`scripts/link.mjs`** 把 `bin/say` 接入 bin 目录，实现同名接管系统 `say`：

- 默认目标 `~/.local/bin/say`（`DEFAULT_BIN_DIR`，PATH 前置位，全局激活）；`--bin-dir` 可重定向（安装验证用临时目录）；`--dry-run` 只打印计划不落盘
- 安全边界：已存在且指向本 shim 的链接直接 skip（幂等）；非本 shim 的同名文件默认拒绝覆盖，`--force` 才 unlink 重建
- 前置 `node --version` 检查：`bin/say` 是 Node 入口，Node 不可用直接报错退出
- 关键机制：`bin/say` 是无扩展名 shebang 入口（`#!/usr/bin/env node`，`import "../src/index.ts"`），Node 对无扩展名文件按 JS 解析、对 `.ts` import 做类型擦除；符号链接的模块解析沿 realpath 落回仓库根，所以一个裸 symlink 即可用，无需包装脚本
- 接线动作落 `raw-log.jsonl`（`phase=link`），`--dry-run` 不入日志
- shadow 生效后系统 `say` 仍可经 `/usr/bin/say` 绝对路径直呼；未支持参数（长尾 flag）由运行时整条透传兜底（`src/fallback.ts` / `src/engines/system.ts`）

## 运行环境要求（汇总）

- macOS 14+、Apple Silicon（M 系列）——依赖系统二进制 `/usr/bin/say`（回退与透传）与 `/usr/bin/afplay`（播放，`src/player.ts:4`）
- Node ≥ 22.18（原生运行 `.ts`），pnpm
- 首次安装约 760MB 模型资产（`~/.cache/say/models/`）
- 代理场景：`HTTPS_PROXY`/`HTTP_PROXY` 透传；`SAY_*` 环境变量族（`SAY_ENGINE` / `SAY_VOICE` / `SAY_SPEED` / `SAY_PRESET` / `SAY_FALLBACK` / `SAY_DEBUG`）为运行时配置层

## 配置与构建产物

- 配置文件：`package.json`、`tsconfig.json`、`vitest.config.ts`、`pnpm-lock.yaml`（提交进 git）
- 无构建产物：`noEmit` 且无构建步骤；`.gitignore` 预留 `dist/` 但当前无产出；`bin/say` 即发布面
- `.planning/` 之外的开发产物目录：`docs/research/`（调研与部署证据链，gitignored）、`zRefs/`（本地调试参考，gitignored）、`.nsl/`（编排状态，gitignored）

技术栈分析：2026-09-19
