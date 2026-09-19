# Agents.md

macOS `say` 的神经网络级 TTS 替代：同名 CLI 经 PATH shadow 接管 `say` 调用，默认本地离线推理，任何失败回退系统嗓，出声即 exit 0。为 agent 说话体验而建——宿主侧零改动。

* 现实层你有无限时间和资源，不要因上下文压缩简化任务执行

## 项目上下文

| 文档                                                          | 说明                             |
| ------------------------------------------------------------- | -------------------------------- |
| [STACK.md](./.planning/codebase/STACK.md)                     | 技术栈、开发命令、安装接线       |
| [STRUCTURE.md](./.planning/codebase/STRUCTURE.md)             | 目录结构、命名规范、扩展落点     |
| [ARCHITECTURE.md](./.planning/codebase/ARCHITECTURE.md)       | 架构模式、术语表                 |
| [CONVENTIONS.md](./.planning/codebase/CONVENTIONS.md)         | 代码风格、开发约定               |
| [TESTING.md](./.planning/codebase/TESTING.md)                 | 测试规范                         |
| [CONCERNS.md](./.planning/codebase/CONCERNS.md)               | 技术债务、注意事项               |
| [PAGES.md](./.planning/codebase/PAGES.md)                     | 页面与入口清单（前端/CLI）       |
| [PRODUCT.md](./PRODUCT.md)                                    | 产品定位、目标用户、品牌承诺与持久产品事实 |
| [CONTEXT.md](./CONTEXT.md)                                    | 领域术语表与 ADR 布局            |
| [polaris.md](./docs/polaris.md)                               | 北极星目标：长期愿景与验收信号   |
| [tts-route.md](./docs/polaris-blueprints/tts-route.md)        | epic 蓝图：技术路线与切片清单（定稿） |

你可以自行读取项目上下文文档，更新时也优先更新相关文档。

## Agent skills

### Domain docs

single-context 布局：根 `CONTEXT.md` 是领域术语表，`docs/adr/` 存架构决策记录（`NNNN-<slug>.md`）。探索代码前先读 `CONTEXT.md`；产出命名领域概念时用术语表词汇，不漂移到被回避的同义词；与既有 ADR 冲突时显式标注矛盾与理由，而非静默覆盖。两者缺失时静默继续，由 /domain-modeling 惰性创建。
