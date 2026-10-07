#!/usr/bin/env python3
"""GPT-SoVITS 子进程协议 shim（引擎层 v2 协议钉版，S3）。

api_v2 同核（GPT_SoVITS.TTS_infer_pack.TTS）的 stdin/stdout JSON 行薄封装：
请求/响应字段与 api_v2 /tts 一比一同名（snake_case），传输层从 HTTP 换成行管道。
协议契约见 say 仓 docs/engine-protocol.md，改帧格式两处（本文件与
src/engines/gptsovits-protocol.ts）同改。

用法（由 src/engines/gptsovits-binding.ts spawn，cwd 无要求）：
    <say-lab venv python> gptsovits-shim.py --repo <GPT-SoVITS 仓库根>

为什么协议输出不走 sys.stdout：GPT-SoVITS 引擎层与依赖库大量 print 到 stdout
（模式切换、耗时统计、i18n 提示），会污染行协议——进程启动即把协议通道固定为
fd 1 的副本，sys.stdout 整体改道 stderr，引擎日志与协议帧从此分流。
"""

import argparse
import base64
import hashlib
import json
import os
import sys
import traceback

# 握手版本键的协议常量：daemon 形态 ready 帧携带，Node 侧（src/engines/daemon-session.ts）校验。
# 与仓内 TS 侧常量同步 bump——同仓文件天然同版本，漂移只发生在「旧代码拉起的旧 daemon」场景，
# 那正是握手要拒的对象。per-call 形态不携带（帧消费面忽略未知字段，票 04「帧不动换传输」）。
PROTOCOL_VERSION = "2"

# 权重指纹的磁盘投影清单：安装期 sha256 校验通过后的 .install-ok marker（install-engine.mjs 写）。
# 与 TS 侧 GPTSOVITS_WEIGHT_MARKERS 逐条一致——漂移会致每次握手失败、静默永久降级 per-call，
# 由 test/daemon-fingerprint.test.ts 双实现对拍钉死。
WEIGHT_MARKERS = [
    "GPT-SoVITS/GPT_SoVITS/pretrained_models/.install-ok",
    "GPT-SoVITS/GPT_SoVITS/text/G2PWModel/.install-ok",
    "open_jtalk_dic_utf_8-1.11/.install-ok",
    "venv/nltk_data/tokenizers/punkt_tab/.install-ok",
    "venv/nltk_data/taggers/averaged_perceptron_tagger_eng/.install-ok",
    "venv/nltk_data/corpora/cmudict/.install-ok",
]


def weights_fingerprint(lab_dir: str) -> str:
    """marker 清单（rel 升序）逐条 `rel|size|mtime_ms`（缺项 `rel|missing|0`）换行 join 的 sha256。

    毫秒取整与 TS 侧 BigIntStats.mtimeMs 同 floor 语义（epoch 纳秒直接超 2^53，浮点不可靠）；
    粒度对安装事件足够。升级重装重写 marker → mtime 变 → 旧 daemon 握手失效自动重拉（票 04 §1）。
    """
    lines = []
    for rel in sorted(WEIGHT_MARKERS):
        path = os.path.join(lab_dir, rel)
        try:
            st = os.stat(path)
            lines.append(f"{rel}|{st.st_size}|{st.st_mtime_ns // 1_000_000}")
        except OSError:
            lines.append(f"{rel}|missing|0")
    return hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description="GPT-SoVITS say shim")
    parser.add_argument("--repo", required=True, help="GPT-SoVITS 仓库根（权重相对路径与配置写盘按它解析）")
    parser.add_argument("--lab", default=None, help="say-lab 引擎目录（daemon 形态 sock/pid/log 与权重指纹落点）；缺省按 repo 父目录推导")
    parser.add_argument("--print-fingerprint", action="store_true", help="只打印权重指纹并退出（排障与公式对拍用，不触引擎 import）")
    args = parser.parse_args()

    if args.print_fingerprint:
        lab = os.path.abspath(args.lab) if args.lab else os.path.dirname(os.path.abspath(args.repo))
        print(weights_fingerprint(lab))
        return 0

    repo = os.path.abspath(args.repo)
    os.chdir(repo)  # TTS_Config 的相对权重路径按 cwd 解析，且首次构造会向 GPT_SoVITS/configs/ 写 tts_infer.yaml
    sys.path.insert(0, repo)
    sys.path.insert(0, os.path.join(repo, "GPT_SoVITS"))

    # 协议通道先于引擎 import 固定：import 期就可能 print
    protocol = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
    sys.stdout = sys.stderr

    def emit(obj) -> None:
        protocol.write(json.dumps(obj, ensure_ascii=False) + "\n")
        protocol.flush()

    try:
        import numpy as np

        from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config

        int16 = np.int16
        # CPU 档显式钉死（调研实证 MPS 全线慢 1.5-2 倍弃用）；权重走仓库默认 v2 预训练路径
        config = TTS_Config({"custom": {"device": "cpu", "is_half": False, "version": "v2"}})
        pipeline = TTS(config)
        emit({
            "type": "ready",
            "engine": "gptsovits",
            "version": str(config.version),
            "device": str(config.device),
        })
    except Exception as e:  # noqa: BLE001 — 加载期任何失败都按 fatal 报给协议对端
        emit({"type": "fatal", "message": f"{type(e).__name__}: {e}"})
        return 1

    for line in sys.stdin:
        stripped = line.strip()
        if not stripped:
            continue
        try:
            req = json.loads(stripped)
        except json.JSONDecodeError as e:
            emit({"type": "error", "id": -1, "message": f"bad request json: {e}"})
            continue
        if req.get("type") == "shutdown":
            break
        req_id = req.get("id", -1)
        try:
            inputs = {
                "text": req["text"],
                "text_lang": req.get("text_lang", "auto"),
                "ref_audio_path": req["ref_audio_path"],
                "prompt_text": req.get("prompt_text", ""),
                "prompt_lang": req["prompt_lang"],
                # 切分归调用方（say 的 normalize 已按句切块），shim 内不再切，保住首包延迟
                "text_split_method": "cut0",
                "speed_factor": float(req.get("speed_factor", 1.0)),
                "streaming_mode": False,
                "return_fragment": False,
            }
            sample_rate = None
            audio = None
            # TTS.run 是生成器且异常路径会先 yield 空音频再 raise：迭代到结束才算成功
            for sr, chunk in pipeline.run(inputs):
                sample_rate, audio = int(sr), chunk
            if audio is None or sample_rate is None:
                emit({"type": "error", "id": req_id, "message": "engine produced no audio"})
                continue
            if audio.dtype != int16:
                audio = audio.astype(int16)
            emit({
                "type": "audio",
                "id": req_id,
                "pcm": base64.b64encode(audio.tobytes()).decode("ascii"),
                "sample_rate": sample_rate,
                "done": True,
            })
        except KeyError as e:
            emit({"type": "error", "id": req_id, "message": f"missing request field: {e}"})
        except Exception as e:  # noqa: BLE001 — 单请求失败按 error 回报，进程保持存活
            # traceback 走 stderr（协议面保持纯净）：EngineError 只携带首行，根因现场靠这里落到对端日志
            traceback.print_exc()
            emit({"type": "error", "id": req_id, "message": f"{type(e).__name__}: {e}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
