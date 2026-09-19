# Changelog

本项目的所有重要变更都记录在此文件中。

格式基于 Keep a Changelog，版本号遵循语义化版本。

## [Unreleased]

### Added

- 神经 TTS CLI：`say` 的直接替代品——sherpa-onnx 进程内推理（kokoro fp32 103 嗓 + matcha），`/usr/bin/say` 兼作回退后端与未支持 flag 的透传目标；`-v / -r / -o / -f` 与 stdin 兼容，出声即 exit 0；缺资产、静音或异常时自动回退系统嗓，stderr 留一行 `fallback:` 原因，可配置关闭
- ZipVoice 零样本克隆嗓接入：`-v <角色>` 直达 `~/.local/share/say/voices/` 的参考音频 + 逐字转写（lucy / dva / frieren，frieren 另有 `frieren-en` / `frieren-zh` 语言变体）；模型权重全局一份，角色只是克隆参数
- 三层预设机制：config `[presets.<name>]`、`SAY_PRESET` env、`--preset` flag，优先级 flag > env > config；内置通用嗓预设 `en`（kokoro）与 `zh`（matcha）
- 长文本流水播放：超过 400 近似 token 按句边界分块（块预算 30 起每块 ×2.5 封顶 160），出声卡模式边播边合成，600 词实测等待 2.7s、总墙钟 ≈ 播放时长；`-o` 模式合并单 wav
- 本机跑分基建：`node bench/run.mjs` 8 通道 × 4 文本 × 冷热延迟矩阵，报告数字可从 raw-log 全格重算对账
- 安装接线：`scripts/install-models.mjs` 幂等下载五组引擎资产（代理透传 + HF_ENDPOINT 镜像扩展位，`--verify` 审计）；`scripts/link.mjs` PATH shadow 接线（dry-run 预览、非本 shim 占位拒覆盖）；README 快速上手与多 runtime 冒烟

### Fixed

- 合成失败与资产缺失时回退系统嗓，出声即算成功：分块中途失败先等在飞合成落地再写原因行（fd 2 遮罩窗口问题），出声卡拿到文件产物判交付失败，回退等待计入耗时摘要使分项与 total 闭合
- ZipVoice 语速安全边界：加速（speed > 1）会在克隆推理 native 层永久挂起，克隆链路只在放慢方向下发语速，加速请求写 stderr 说明并忽略
- kokoro int8 经 sherpa-onnx-node 动态库产出全 NaN 静音：权重钉定 fp32，适配器以能量与说话人数校验样本，验不过判失败交给回退，不交付静音
