# 测试模式（Testing Patterns）

**分析日期：** 2026-09-19

## 测试框架

**运行器：**
- vitest ^5.0.1（devDependency，见 `package.json`）
- 配置：`vitest.config.ts`（仅 10 行，关键设定都在这里）

**断言库：**
- vitest 内置 `expect`（未引入 chai/jest-extra）

**配置要点（`vitest.config.ts`）：**
```ts
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // 单测不得触碰真实模型资产与用户配置：任何用例若走到 ~/.cache/say 或 ~/.config/say 即视为接缝泄漏
    env: { HOME: "/nonexistent-say-test-home" },
  },
});
```
- `HOME` 注入为不存在的路径是硬约束：任何测试若读到真实用户目录即视为接缝泄漏（接缝指 `src/host.ts` 的 Host 接口）。新增测试必须经 Host 注入 env，不得直接读 `process.env` 或 `os.homedir()`。
- `src/paths.ts:14`（`resolvePaths`）从注入的 env 解析 HOME/XDG 而不直接问 `os` 模块，正是为了让该隔离生效。

**运行命令（`package.json` scripts）：**
```bash
pnpm test        # vitest run（全量单测）
pnpm typecheck   # tsc --noEmit（strict 全开）
```
- 无 watch / coverage 配置；覆盖率未强制。
- 注意：`scripts/lib/*.test.mjs`（8 个）使用 node:test（非 vitest），不在 `pnpm test` 范围内，需手动 `node --test scripts/lib/*.test.mjs` 运行（详见「测试类型」节；`node --test` 传目录在 Node 22 会按模块解析而失败）。

## 测试文件组织

**位置：** 集中在 `test/` 目录（不与源码同目录 co-locate），`test/fake-host.ts` 是共享测试替身而非测试。

**命名：** `<被测模块名>.test.ts`，与 `src/` 大体按模块镜像。

**测试 ↔ 源码映射：**

| 测试文件 | 被测目标 |
| --- | --- |
| `test/cli.test.ts` | `src/cli.ts`（parseArgv 兼容调用面） |
| `test/config.test.ts` | `src/config.ts`（配置解析与优先级） |
| `test/presets.test.ts` | `src/config.ts`（预设合并/降级） |
| `test/paths.test.ts` | `src/paths.ts`（XDG 三落点解析） |
| `test/normalize.test.ts` | `src/normalize.ts`（文本规范化与分块） |
| `test/wav.test.ts` | `src/wav.ts`（RIFF/WAVE 编码） |
| `test/stderr.test.ts` | `src/stderr.ts`（fd 2 遮罩与恢复） |
| `test/player.test.ts` | `src/player.ts`（afplay 调用与错误归因） |
| `test/delivery.test.ts` | `src/delivery.ts`（交付：落盘/出声卡） |
| `test/voices.test.ts` | `src/voices.ts`（音色列举） |
| `test/fallback.test.ts` | `src/fallback.ts` + `src/speak.ts`（回退编排） |
| `test/speak.test.ts` | `src/speak.ts`（run 编排闭环，system 引擎路径） |
| `test/speak-chunked.test.ts` | `src/pipeline.ts`（分块流水，注意文件名不叫 pipeline） |
| `test/speak-sherpa.test.ts` | `src/speak.ts` + `src/engines/sherpa.ts`（进程内引擎交付链路集成） |
| `test/sherpa.test.ts` | `src/engines/sherpa.ts`（适配器：路由/可用性/能量校验） |
| `test/sherpa-voices.test.ts` | `src/engines/sherpa-voices.ts`（内嵌 103 音色 sid 表） |
| `test/zipvoice.test.ts` | `src/engines/zipvoice.ts`（克隆嗓适配器） |

**无独立测试文件的源码：** `src/index.ts`（main 组装，经 speak.test 间接覆盖）、`src/report.ts`、`src/errors.ts`、`src/executor.ts`（daemon 分支抛 NotImplementedError 未见直接用例）、`src/engines/sherpa-binding.ts` 与 `src/engines/zipvoice-binding.ts`（native 绑定层，设计上不进单测，由 bench 证据链与冒烟覆盖，见下文）。

## fake-host 测试替身模式（核心）

本仓单测完全不使用 `vi.mock`。所有触达操作系统的动作收敛在 `src/host.ts:29` 的 `Host` 接口上，单测注入假实现（`test/fake-host.ts:29` `createFakeHost`）。`test/fake-host.ts:24` 的注释说明了原因：模块级 mock 拦不到被测模块内部的静态 import，而 Host 接缝让单测不需要真实模型、真实 `/usr/bin/say` 与真实用户配置目录。

**基本用法：**
```ts
import { createFakeHost } from "./fake-host.ts";

const fake = createFakeHost({
  env: { HOME: "/h" },          // 注入 env，隔离真实用户目录
  pid: 4242,                    // 临时文件名断言依赖它
  tmpDir: "/var/tmp",
  files: { "/usr/bin/say": "" },// 存在的路径 → 内容；未列出的路径视为不存在
  stdin: "",
  spawnOutcome: (record) => ({ exitCode: 0, signal: null, stdout: "...", stderr: "" }),
  now: () => 0,                 // 注入时钟
});
```

**断言观察面（createFakeHost 返回值）：**
- `spawns`：所有 spawn 调用记录（`{ cmd, args, stdin }`），断言"系统嗓被调起"以 `spawns.some(s => s.cmd === SAY)` 为准（`test/fallback.test.ts:56`），而不是只看退出码
- `writes` / `renames` / `removes`：写盘、原子改名、清理的完整轨迹
- `stderr`：writeStderr 收集的行，用于断言 `say: fallback:` 原因行（`test/fallback.test.ts:67`）
- `files`：虚拟文件表状态

**局部覆写模拟故障（不用 mock，直接展开覆盖单方法）：**
```ts
const host = {
  ...fake.host,
  writeFile: async () => { throw new Error("ENOSPC: no space left on device"); },
};
```
该模式见于 `test/speak-sherpa.test.ts:130`（EROFS）、`:177`（ENOSPC）、`:158`（renameFile 抛 EXDEV）——分别验证"不留半截产物冒充成功"与"清掉 PID 临时文件不留孤儿"。

**native 合成的注入缝：** 引擎工厂接受 `synth` 函数参数（`createSherpaEngine({ host, modelsDir, synth })`），生产默认接 `synthesizeWithBinding`（`src/engines/index.ts:69`），单测注入 `fakeSynth`。见 `test/sherpa.test.ts:41` 与 `test/zipvoice.test.ts:62`：
```ts
function fakeSynth(result = {}) {
  const calls: SherpaSynthRequest[] = [];
  const synth: SherpaSynth = async (req) => {
    calls.push(req);
    return { samples: new Float32Array([0.1, -0.2, 0.3]), sampleRate: 24000, numSpeakers: 103 };
  };
  return { synth, calls };
}
```
`calls` 用于断言音色名 → sid / speed / 模型规格的路由结果。

## 引擎测试的资产依赖处理

单测**从不加载真实模型或 native 绑定**（sherpa-onnx-node），处理方式全部是"文件存在性模拟 + 合成函数注入"：

1. **资产在盘与否 = files 表里有没有对应路径。** 测试文件顶部定义 fixture 常量：`KOKORO_FILES`（8 项必需文件，`test/sherpa.test.ts:20`）、`MATCHA_FILES`（含 vocoder 路径，`test/sherpa.test.ts:30`）、zipvoice 的 `MODEL_FILES` + 角色三件套（`test/zipvoice.test.ts:22`）。内容一律空串——可用性判定只看存在性。
2. **部分缺失场景用 Object.fromEntries 派生**：如"只装 matcha"（`test/speak-sherpa.test.ts:18` `MATCHA_ONLY_FILES`）、"只有 int8 权重"（把 `model.onnx` 换名成 `model.int8.onnx`，`test/sherpa.test.ts:126`）——验证引擎判不可用并回退系统嗓，而不是拿 int8 合成静音。
3. **files 表是整体替换不是叠加**：`test/speak-sherpa.test.ts:54` 注释明确"缺资产的用例必须能把默认那套模型文件真的抹掉"。
4. **`say -v ?` 系统嗓清单**：用 `spawnOutcome` 返回固定 stdout（`"Tingting            zh_CN    # 你好\n..."`），验证开放集委派路由（`test/sherpa.test.ts:299`、`test/speak-sherpa.test.ts:215`）。
5. **绑定层自身（`src/engines/sherpa-binding.ts` / `zipvoice-binding.ts`）无单测**：native 路径由 bench 证据链（192 行真实合成入 `docs/research/bench/raw-log.jsonl`）与部署冒烟覆盖。修改绑定层时以 bench 的 `--verify` 对账 + `docs/research/deploy/report.md` 冒烟为验收，不新增 vitest。

**音频产出有效性测试**（资产漂移防线，`test/sherpa.test.ts:231`）：
```ts
it("全 NaN 样本被判为合成失败，不产出静音文件冒充成功", async () => {
  const { engine } = makeEngine(fakeSynth({ samples: new Float32Array([NaN, NaN, NaN]) }).synth);
  await expect(engine.speak("hi", speakOpts())).rejects.toThrow(/NaN|能量|静音/);
});
```
背景：int8 kokoro 权重经 Node 绑定产出全 NaN 静音（详见 CONCERNS.md），`assertAudible`（`src/engines/sherpa.ts:51`）在样本层验证能量，测试锁定该防线不被移除。同样存在全零样本、numSpeakers 与内嵌表错配（54 ≠ 103）的判死用例。

## 测试结构

**套件组织（describe 用中文描述行为契约，it 描述可观察结果）：**
```ts
describe("进程内引擎的 pcm 交付：-o 落盘", () => {
  it("封成 wav 写入 PID 临时名再原子改名到目标", async () => {
    const { code, writes, renames } = await invoke({ pid: 4242 }, ["-o", "/out/a.wav", "hi"]);
    expect(code).toBe(0);
    expect(writes[0]?.path).toBe("/out/a.wav.4242.tmp");
    expect(renames).toEqual([{ from: "/out/a.wav.4242.tmp", to: "/out/a.wav" }]);
  });
});
```
（`test/speak-sherpa.test.ts:72`）

**模式：**
- 每个文件顶部集中定义常量（`SAY`、`TMP`、`MODELS`、fixture 文件表），工厂函数（`setup`/`invoke`/`makeEngine`）组装 fake host + registry 后调 `run()`（`src/speak.ts`），这是编排层测试的统一入口形态
- 表驱动用 `it.each`（flag 同义性、透传判定，`test/cli.test.ts:38-114`）
- 错误断言用 `rejects.toThrow(/音色名/)` 精确到原因关键词，而不是笼统 rejects.toThrow()
- 回退语义断言"恰好一行 fallback 原因"（`test/fallback.test.ts:67` 按行 split 后 toHaveLength(1)）
- 注释解释为什么（如 `test/speak-sherpa.test.ts:195` 解释 ENOSPC 下为何仍恒清一次），不写开发追踪标记

## Mocking

**框架：** 无（不使用 vi.mock / jest.mock）。

**要替换的：** 一切经 `Host` 接口的 OS 动作（spawn、文件系统、stderr、时钟、stdin）；native 合成经 `SherpaSynth` / `ZipvoiceSynth` 函数缝注入。

**不要 mock 的：**
- 不要 mock 模块内部（静态 import 拦不住，且会掩盖接缝泄漏）
- 不要在单测触碰真实 `~/.cache/say`、`~/.config/say`、`/usr/bin/say`——vitest 的 `HOME=/nonexistent-say-test-home` 会把这类泄漏变成 ENOENT 失败
- 不要 mock `wpmToSpeed`、`chunkText` 等纯函数——`test/speak-chunked.test.ts:35` 特意从规范化层取块数（`chunkText(LONG).length`）而非写死，验证编排层用的是同一套分块

## Fixtures 和测试数据

**形态：** 无外部 fixture 文件，全部是测试内联的路径表与文本常量。
- 模型资产表：`KOKORO_FILES` / `MATCHA_FILES` / `MODEL_FILES`（各引擎测试顶部）
- 角色元数据：`LUCY_META` / `FRIEREN_META`（JSON 字符串，含 variants 多语言变体，`test/zipvoice.test.ts:31`）
- 长文本生成器：`longText(sentences, words)` 构造超分块阈值文本（`test/speak-chunked.test.ts:31`）
- 有能量样本约定：`new Float32Array([0.2, -0.3, 0.4])`——全零/全 NaN 会被 `assertAudible` 判死，测不到交付链路（`test/speak-sherpa.test.ts:42`）

## 测试类型

**单元测试（vitest）：** 17 个 `test/*.test.ts`，纯逻辑 + fake host，毫秒级、无网络、无模型。覆盖 CLI 解析、配置、路由仲裁、回退、交付、分块、引擎适配。

**脚本层测试（node:test，不在 pnpm test 内）：** `scripts/lib/pipeline.test.mjs`、`scripts/lib/verify.test.mjs`，用 `import test from "node:test"` + `node:assert/strict`，验证采集管线命令构造（ffmpeg/demucs/zipvoice 参数）与角色包校验逻辑。期望值锚定 s-bench raw-log 中已验证的真实命令形态（独立事实源）。运行：`node --test scripts/lib/*.test.mjs`（显式文件形态；传目录 Node 22 按模块解析报错）。

**跑分基线（bench/，非测试框架，是证据链系统）：**

- 入口：`bench/run.mjs` 四模式——`--setup`（资产落地，幂等）、`--bench`（跑矩阵）、`--report`（生成报告）、`--verify`（证据链对账，exit 1 = 有缺项）
- 证据链契约：所有真实执行（安装/下载/合成）经 `bench/lib/log.mjs` 落 `docs/research/bench/raw-log.jsonl`（append-only），报告数字只从 log 聚合（`bench/lib/verdict.mjs` `aggregateCells` 按中位数成格），verify 与 report 共享同一判定函数防口径漂移
- 矩阵口径（`bench/lib/config.mjs`）：8 通道 × 4 固定文本（en-short/en-long/zh-short/zh-mixed，写死保证跨轮次可比）× 冷/热 × 3 轮取中位数 = 192 行真实合成。spawn 通道每格 6 次调用前 3 次 cold 后 3 次 hot；Node 绑定通道（paired）单 worker 进程内产出 cold+hot 两行
- 验收判据（polaris 口径，`bench/lib/verdict.mjs:17`）：热 ≤3s / 冷 ≤10s → PASS；超标 ≤1.5× → MARGINAL；>1.5× → FAIL
- 样本有效性（`bench/lib/config.mjs`）：绝对下限 0.5s/22050 数据字节，叠加相对判据 `DEGENERATE_RATIO = 0.25`（时长 < 同文本 system-say 对照的 25% 判退化）——绝对下限挡不住"长文本只出零点几秒噪声"的形态
- 基线结论（`docs/reports/260919-s-bench-v2.md`，M3 实测）：system-say 0.54~0.77s 全 PASS（延迟基线）；matcha zh_baker Node 通道热态 0.20~0.42s 全 PASS（唯一免 daemon 达标的中文神经嗓）；kokoro-int8 Node 热态 en-short 1.59s PASS / en-long 9.98s FAIL；zipvoice Node 热态 3/4 PASS（en-long 14.35s FAIL）；mlx Qwen3-TTS en-long 9.12s FAIL。F2 建议：kokoro/zipvoice/mlx 长文本需 daemon 化，matcha 中文可直跑
- 注意：bench 跑分用的 kokoro 权重是 int8 包（bench 专用资产），运行时钉定 fp32（见 CONCERNS.md），两组性能数字不可直接互换

## 常见模式

**异步测试：** 全部 async/await，编排层直接 `await run(argv, deps)` 断言退出码；无 fake timers（时钟经 `Host.now` 注入）。

**错误测试：**
```ts
await expect(engine.speak("hi", opts)).rejects.toBeInstanceOf(EngineError);
await expect(engine.speak("hi", opts)).rejects.toThrow(/Tingting/);  // 原因必须点名音色
```

**子进程结局语义：** `spawnOutcome` 返回 `{ exitCode: number | null, signal: string | null, stdout, stderr }`——被信号杀死时 exitCode 为 null，有专门用例锁定"仍按失败处理而非误判成功"（`test/speak.test.ts:97`）。

**新增测试的检查单：**
1. 走 `createFakeHost`，env 注入 HOME，绝不读真实用户目录
2. 需要模型在盘 → 把必需文件路径加进 files 表（空串即可）
3. 需要引擎行为 → 注入 fakeSynth，不 import 任何 binding 模块
4. describe/it 用中文写行为契约；断言观察 writes/renames/removes/spawns/stderr 轨迹而非内部状态
