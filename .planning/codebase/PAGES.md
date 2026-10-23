# 页面与入口清单

<!-- refreshed: 2026-10-22 -->

数据来源：`package.json#bin` 静态提取 + `src/cli.ts` 的 `SUPPORTED_FLAGS` 表与 `CliRequest` 联合类型核对。CLI 侧（`bin` 为 string 形态）按约定退化为一张命令表，不开明细节。flags 增删以 `src/cli.ts` 为唯一事实源，本清单过期以代码为准。

## 命令总览

| 命令  | 实现文件                | 用法                        | 说明                                       |
| ----- | ----------------------- | --------------------------- | ------------------------------------------ |
| `say` | `bin/say` → `src/index.ts` | `say "text"` / `echo text \| say` | macOS say 同名 shim；argv 解析在 `src/cli.ts` |

## Web 入口（packages/playground）

| 入口 | 实现 | 说明 |
| --- | --- | --- |
| 嗓音工作台 `/` | `packages/playground/app/pages/index.vue` | `pnpm dev:playground` 起（port-key 独立端口，host 127.0.0.1）。六区：档期列表、70 格嗓位矩阵、粘性播放器、活体合成台、盲听 A/B 裁决、裁决历史。试听裁决唯一交互面，数据落 `docs/audition/<YYMMDD>/`（JSON+wav），不再产 report HTML |

## flags 明细

| flag                          | 说明                                                              |
| ----------------------------- | ----------------------------------------------------------------- |
| `-v` / `--voice <音色\|角色>`  | 引擎内登记音色，或角色克隆嗓目录名；`-v ?` 列表模式透传系统 say     |
| `-r` / `--rate <wpm>`         | 语速，正数，默认 175（macOS say 同锚点）                           |
| `-o` / `--output-file <文件>` | 合成结果写文件而非播放                                             |
| `-f` / `--input-file <文件>`  | 从文件读正文；`-` 表示 stdin                                       |
| `--preset <名>`               | 选择启动预设（内置 `en`/`zh`，可于 config.toml 扩展）               |
| 其余一切                      | 整条透传 `/usr/bin/say`（如 `--progress`、音频格式族、`-a`、`-n`） |
