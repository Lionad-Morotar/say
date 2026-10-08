# CONTEXT

本仓库领域术语表。工程技能产出（issue 标题、重构提案、假设、测试命名）命名领域概念时使用此词汇，不漂移到被回避的同义词；术语缺口经 /domain-modeling 惰性补充。

## 术语

| 术语 | 定义 | 回避的同义词 |
| ---- | ---- | ------------ |
| shim | 本工具整体：接管 `say` 调用名的同名替代 CLI | wrapper、proxy |
| 透传（passthrough） | 未登记参数整条原样转交 `/usr/bin/say` 并继承退出码，不做部分改写 | fallback（回退另有所指） |
| 回退（fallback） | 引擎失败后转系统嗓出声并写一行 stderr 原因，出声即 exit 0 | degrade、降级 |
| 音色（voice） | 引擎内登记的嗓音标识（如 `af_maple`、`zh_baker`） | speaker（zipvoice 域另有所指）、model |
| 角色（character） | zipvoice 零样本克隆嗓：一个参考音频目录即一个可 `-v` 的嗓音 | persona |
| 预设（preset） | 启动参数组（voice/engine/speed），三层配置中最低一档显式层，手动指定永远胜出 | profile、theme |
| 默认嗓关键字（default） | v2 voice 枚举关键字：`voice = "default"` 按系统 locale（AppleLanguages 优先、LANG 兜底、缺省 en）落 en/zh 内置预设；frieren/dva 是平行的角色嗓枚举值 | auto、none |
| shadow | 经 `~/.local/bin/say` 符号链接在 PATH 上接管系统 say 的机制 | hijack、override |
| 流水（streaming） | 长文按句边界分块：播块 i 时合成块 i+1，首包出声先于整段完成 | chunked playback |
| 引擎三态 | sherpa（神经多语）/ zipvoice（角色克隆）/ system（回退与透传目标）三执行后端 | provider |
| 常驻（daemon） | 跨 CLI 调用保活的引擎服务进程，权重与设备初始化留在内存中持续服役；与 per-call（一次调用一个 shim 进程）相对 | server、service |
| 温态（warm）/ 冷启动（cold） | 温态指权重已在内存、请求直达推理；冷启动指从零到可推理的全过程（spawn、import、权重加载、设备初始化） | hot、loaded |
| 闲置收割（idle reap） | daemon 持续无请求达阈值后自行退出归还内存，下次调用重新冷启动 | timeout kill |
| 注册点（registration points） | say-lab 引擎目录下的 daemon.sock / daemon.pid / daemon.log 三件：sock 在位即可发现常驻，ls 六态判定与 stop 双通道触达全部以此为根据 | lock 文件、registry |
| 熔断冷却（cooldown） | daemon 基础设施失败连击达阈后拒触达直走 per-call 的窗口期，期满自动恢复触达；SAY_DEBUG daemon 段词表之一 | breaker open、熔断中 |
| 出声即 exit 0 | 回退语义的验收锚点：只要用户听到了声音，进程就必须成功退出 | silent success |

## 架构决策记录

`docs/adr/` 存放架构决策记录，命名 `NNNN-<slug>.md`。当前无在档 ADR；决策随开发惰性归档。
