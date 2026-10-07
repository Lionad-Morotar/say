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
import json
import os
import sys
import traceback


def main() -> int:
    parser = argparse.ArgumentParser(description="GPT-SoVITS say shim")
    parser.add_argument("--repo", required=True, help="GPT-SoVITS 仓库根（权重相对路径与配置写盘按它解析）")
    args = parser.parse_args()
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
