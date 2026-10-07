# say

macOS `say` 的神经网络级替代：同名 CLI，PATH shadow 接管 `say` 调用，默认本地离线推理，任何失败回退系统嗓，出声即 exit 0。为 agent 说话体验而建——调用面就是 `say <text>`，宿主侧零改动。

环境要求：macOS 14+、Apple Silicon（M 系列）、Node ≥ 22.18（实测 22.22）、pnpm。

## 快速上手

```sh
git clone <本仓库> && cd say
pnpm install
node scripts/install-models.mjs   # v1 基线资产（sherpa/zipvoice），幂等可重跑，约 760MB
node scripts/install-engine.mjs install gptsovits   # 可选：默认引擎 GPT-SoVITS v2（约 7.0GB，含 NLTK 数据）
node scripts/link.mjs --dry-run   # 预览接线计划，不落盘
node scripts/link.mjs             # 接入 ~/.local/bin（全局激活；--bin-dir 可重定向）
say "hello, this is the new voice"
```

`install-engine.mjs` 管理四引擎安装面（`status [--json]` 查询 / `install <engine>` 幂等安装，engine 可选 `gptsovits|voxcpm|indextts|firered|all`）：uv venv 隔离 + ModelScope/hf-mirror 双通道权重下载 + sha256 校验 + FireRed patch。装了哪个引擎，`--engine` 就能切哪个；未安装的引擎选择会被回退链兜住（stderr 一行原因，出声即 exit 0）。

`install-models.mjs` 幂等：已就绪资产打印 `skip`，缺失才下载；`--verify` 只审计不下载（exit 1 = 有缺项）。下载走 GitHub Releases，自动透传 `HTTPS_PROXY`/`HTTP_PROXY` 代理环境变量；HF 源资产（当前清单无）支持 `HF_ENDPOINT` 镜像 fallback。权重钉定 fp32——int8 的 kokoro 包经 Node 绑定会产出全 NaN 静音，不进安装清单。

角色克隆嗓（可选）：`node scripts/fetch-voices.mjs` 走采集管线，或按「添加角色嗓」节手动放置。

## 引擎切换

优先级：`--engine` flag > `SAY_ENGINE` env > config `engine` 字段。

```sh
say engine ls                        # 七引擎清单（wired = 注册表就绪）
say engine use gptsovits             # 写 config 默认引擎（持久）
say --engine voxcpm "流式引擎试一句"   # 逐次指定，不改 config
SAY_ENGINE=indextts say "节奏引擎"     # 会话级指定
```

默认预设按 locale 每次调用现场解析：AppleLanguages 优先、LANG 兜底、缺省 en。`voice = "default"` 关键字按 locale 落内置预设；`frieren` / `dva` 角色名直接作 voice 使用（引擎支持克隆时认领）。要固化引擎与嗓音，用 `say engine use` 写 config。

## 调用面

- `say "text"`：神经嗓出声；`echo text | say`：stdin
- `-v <音色|角色>`、`-r <wpm>`（默认 175，macOS say 同锚点）、`-o <文件>`、`-f <文件>`、`--preset <名>`
- 未支持参数（`--progress`、音频格式族、`-a` 等长尾）整条透传 `/usr/bin/say`，原样继承退出码
- 任何引擎失败回退系统嗓并写一行 `say: fallback: <原因>`，出声即 exit 0；`SAY_FALLBACK=off` 可关闭

## 配置

优先级：flag > env > config；预设值是最低一档显式层，手动 voice/speed/engine 永远胜出。

`~/.config/say/config.toml`（XDG）：

```toml
engine = "gptsovits"     # sherpa | zipvoice | gptsovits | voxcpm | indextts | firered | system
voice = "default"        # default 按 locale 落预设；frieren / dva 角色名；引擎内登记音色名
speed = 175              # wpm，macOS say 同单位
fallback = "system"      # "off" 关闭回退
preset = "zh"            # 启动预设（locale 自动默认，一般无需手写）

[presets.en]             # 内置：en 链（sherpa + kokoro af_maple）/ zh 链（gptsovits + frieren-zh 角色嗓）
voice = "af_maple"
engine = "sherpa"
```

环境变量：`SAY_ENGINE` / `SAY_VOICE` / `SAY_SPEED` / `SAY_PRESET` / `SAY_FALLBACK` / `SAY_DEBUG=1`（一行时序摘要到 stderr）。

## 引擎与音色

| 引擎 | 资产 | 音色 | 说明 |
| --- | --- | --- | --- |
| gptsovits（默认） | GPT-SoVITS v2 pretrained（~7.0GB） | default 预设 + 角色 ref 资产 | 中英热延迟双 PASS（1.3-2.8s），角色克隆零改造映射，微调升级路 |
| voxcpm | VoxCPM2（~4.6GB） | default + 角色 ref | 质量上限选项：generate_streaming 首包 0.2-0.5s，voice creation 指令前缀 |
| indextts | IndexTTS 2.5（~10GB） | default（voice_01）+ 角色 ref | duration_factor 语速近线性（-r 映射），emo_alpha 情感面预留 |
| firered | FireRedTTS3（~20.8GB） | default（prompt_2）+ 角色 ref | 指令控制面最全（语速/pitch/volume），24 语言；上游 CUDA 硬编码已 patch |
| sherpa | kokoro fp32 + matcha-zh | 103 嗓内嵌表（`-v ?`） | v1 基线：英文 af_maple 系、中文 zh_baker 最快 |
| zipvoice | zipvoice-distill-int8 | 角色目录注册表 | v1 克隆基线：零样本，参考音频即嗓音 |
| system | 无 | 系统 say 音色 | 回退后端与透传目标 |

超过 400 近似 token 的长文按句边界分块流水：播块 i 时合成块 i+1，首包出声远早于整段完成。

## 添加角色嗓

在 `~/.local/share/say/voices/<角色名>/` 放三件套即可，无需改代码：

- `ref.wav`：10-30s 单声道 24kHz 干音（越短每调用越快）
- `ref.txt`：参考音频的逐字转写
- `meta.json`：来源/语言/许可注记

三角色参考实现（dva / lucy / frieren，frieren 另含 en/zh 语言变体）由 `scripts/fetch-voices.mjs` 采集。注意：克隆链路只在放慢方向下发语速（`-r` 加速会被忽略并写一行 stderr）。

## 故障排查

- stderr 有 `say: fallback:`：按原因行处理。最常见是模型资产缺失——`node scripts/install-models.mjs --verify` 审计，缺了就重跑安装脚本（断点续传自愈）
- `SAY_DEBUG=1` 看一行摘要：走没走回退、分了几块、时间花在哪
- 完全无声但 exit 0：检查音量与 afplay；写盘模式用 `say -o /tmp/t.wav "x"` 后 `afinfo /tmp/t.wav` 验时长与格式
- 换嗓没生效：越界音色名会被引擎静默回落 sid 0（native 层行为），先 `-v ?` 确认名字在表内
- 资产体积对不上：上游 Releases 不可变，字节不符即残缺，删除对应目录后重跑安装脚本

## 宿主侧零改动

全局激活后（`node scripts/link.mjs` 默认写入 PATH 前置的 `~/.local/bin`），所有 runtime 的 `say <text>` 调用自动切换到神经嗓——不需要修改 CLAUDE.md、hooks 或任何宿主配置。系统 `say` 仍可经 `/usr/bin/say` 绝对路径直呼。