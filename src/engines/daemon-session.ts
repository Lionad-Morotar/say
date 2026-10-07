import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";

/**
 * 常驻 daemon 的 Node 侧会话面（热启动 S1，gptsovits 钉版先行）：
 * unix socket 连接、ready 版本键三元组握手、lazy 拉起编排、请求经 socket。
 * 帧协议逐字沿用 engine-protocol v1（票 04 裁决），变的只是传输层——
 * 所以编解码复用各引擎 protocol 模块，本文件只管「连接与其生命周期」。
 * 与 shim-session（per-call 管道会话）平行存在：一个 shim 脚本双形态共存，
 * per-call 保留为 daemon 不可用时的降级路径。
 */

/** 跨调用常驻进程的基础设施层失败判据（连接拒/拉起死/握手不符/在途断连/超时）——与协议层 error 帧区分：
 * 前者降级 per-call 重放（同请求换个进程再跑一次仍可能成），后者是引擎级失败，重放必复现，不降级 */
export class DaemonUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonUnavailableError";
  }
}

/**
 * 版本握手的期望三元组：协议版本（仓内常量，shim 侧同名常量随仓升级）+
 * 引擎版本（ready.version，钉版引擎的已知值）+ 权重指纹（磁盘投影，见 weightsFingerprint）。
 * 任一不符 = 过期 daemon（旧代码拉的常驻进程），kill 重拉一次而非热切权重（票 02 反面教训 5）。
 */
export interface DaemonVersionKey {
  protocol: string;
  engineVersion: string;
  weightsFingerprint: string;
}

/**
 * gptsovits 权重面投影：安装期 sha256 校验通过后的 .install-ok 标记（install-engine.mjs 落位、
 * engine-status 与 gptsovitsMissingAssets 消费），marker 的 size+mtime_ns 即「这套权重何时被何版本
 * 安装」的指纹。升级重装必然重写 marker → 指纹变 → 旧 daemon 握手失效自动重拉。
 * （票 04 原文的 install 清单 hash 落点在安装脚本、不在本片文件域——marker 投影是其等价机制替代，
 * 决策台账 D2；清单若扩容，两处列表必须同步：本数组与 shim 的 WEIGHT_MARKERS。）
 */
export const GPTSOVITS_WEIGHT_MARKERS: readonly string[] = [
  "GPT-SoVITS/GPT_SoVITS/pretrained_models/.install-ok",
  "GPT-SoVITS/GPT_SoVITS/text/G2PWModel/.install-ok",
  "open_jtalk_dic_utf_8-1.11/.install-ok",
  "venv/nltk_data/tokenizers/punkt_tab/.install-ok",
  "venv/nltk_data/taggers/averaged_perceptron_tagger_eng/.install-ok",
  "venv/nltk_data/corpora/cmudict/.install-ok",
];

/**
 * 权重指纹：对 marker 清单（rel 路径升序）逐条取 `rel|size|mtime_ms`（stat 失败记 `rel|missing|0`），
 * 换行连接后 sha256 hex。与 Python shim 的同名实现必须逐字节一致——
 * 跨语言公式漂移会让每次握手失败、静默永久降级 per-call，故由对拍测试钉死（daemon-fingerprint.test.ts）。
 * mtime 取毫秒而非纳秒：Node Stats 只暴露 ms 面（bigint 形态的 mtimeMs 为整毫秒 bigint），
 * Python 侧对应 `st_mtime_ns // 1_000_000`，两侧同为 floor 语义；ms 粒度对安装事件足够
 * （两次重装不可能落在同一毫秒），且避开 epoch 纳秒超 2^53 的浮点精度陷阱。
 */
export function weightsFingerprint(labDir: string, markers: readonly string[]): string {
  const lines: string[] = [];
  for (const rel of [...markers].sort()) {
    let st;
    try {
      st = statSync(join(labDir, rel), { bigint: true });
    } catch {
      lines.push(`${rel}|missing|0`);
      continue;
    }
    lines.push(`${rel}|${st.size.toString()}|${st.mtimeMs.toString()}`);
  }
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}
