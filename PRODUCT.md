# Product

<!-- impeccable:product-schema 1 -->

## Platform

cli（macOS 本地命令行工具；超出 impeccable 的 web/ios/android/adaptive 四值枚举，如实记录）

## Users

主用户是 AI 编码代理（agent）与其背后的开发者：agent 在终端会话中调用 `say` 获得语音反馈，开发者经 PATH shadow 无感替换系统 say。（推断自 README「为 agent 说话体验而建——调用面就是 `say <text>`，宿主侧零改动」与 scripts/link.mjs 的接线设计；未访谈确认。）

## Product Purpose

macOS `say` 的神经网络级替代：同名 CLI，PATH shadow 接管 `say` 调用，默认本地离线推理，任何失败回退系统嗓，出声即 exit 0。成功意味着 agent 侧零改动获得明显更好听的语音反馈。

## Positioning

调用面兼容即契约：本 shim 是 `say` 的子集 + 其余原样转交（透传 `/usr/bin/say`），而非逐项复刻；配合「出声即 exit 0」的回退语义，宿主侧永远不需要为本工具修改任何调用逻辑。相邻产品（云端 TTS API、需改调用面的语音库）无法在不破坏零改动承诺的前提下复制这一点。

## Operating Context

- macOS 14+、Apple Silicon（M 系列）、Node ≥ 22.18、pnpm
- 模型资产约 760MB，经 `scripts/install-models.mjs` 幂等下载到 `~/.cache/say/models/`
- 接线经 `scripts/link.mjs` 落 `~/.local/bin/say`（PATH shadow）
- 配置于 `~/.config/say/config.toml`（XDG），env 变量 `SAY_*` 族

## Capabilities and Constraints

- 能力：`say "text"` / stdin；`-v`（音色或角色克隆嗓）、`-r`（wpm）、`-o`、`-f`、`--preset`；`-v ?` 列音色；未支持参数整条透传；长文按句边界分块流水播放（播块 i 时合成块 i+1）；三层预设（flag > env > config > preset）
- 引擎：sherpa（kokoro fp32 多语 103 嗓 / matcha zh_baker）、zipvoice（零样本角色克隆）、system（回退与透传目标）
- 硬约束：kokoro 权重钉定 fp32——int8 包经 Node 绑定产出全 NaN 静音，不进安装清单；matcha zh_baker 数据集非商用；bin 入口必须纯 JS（Node 类型擦除按 .ts 后缀启用）

## Evidence on Hand

README.md（调用面、配置、引擎矩阵）、bench/（引擎跑分基线）、docs/tdd 与 docs/reviews（切片任务书与审查记录）、test/（289 测试的镜像覆盖）。无用户访谈、无客户证言——未来工作不得虚构此类证据。

## Product Principles

（推断自 README 与代码注释中的设计决策，未访谈确认）

1. 兼容优先：调用面就是契约，长尾交给系统 say 兜底，绝不为了功能扩张破坏同名语义
2. 离线默认：本地推理为主路径，网络只服务资产下载
3. 永不无声失败：任何引擎失败回退系统嗓并写一行 stderr 原因，出声即 exit 0
4. 声音即体验：模型选型以听感为最终裁决（fp32 钉定、默认嗓试听矩阵）
