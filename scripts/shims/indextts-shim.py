#!/usr/bin/env python3
"""IndexTTS 2.5 整句协议 shim（引擎层 v2 协议复用，S5）。

IndexTTS2.infer()（整句形态，stream_return=False）的 stdin/stdout JSON 行薄封装，
协议契约见 say 仓 docs/engine-protocol.md（S3 钉版），本文件与
src/engines/gptsovits-protocol.ts 是同一契约的另一侧执行面。

引擎侧差异点（相对 voxcpm/gptsovits shim）：
- 零样本克隆引擎：ref_audio_path 必带（引擎内置参考不存在，default 嗓由 Node 侧指到
  仓库自带示例音频）；lang 必填（发音语言与参考音频语言独立，Node 侧自判后下传）。
- duration_factor / emo_alpha 为协议新增可选字段：缺席时零透传（infer 的引擎默认值生效）。
- 单请求产出单帧：infer 整句形态一次返回 (sample_rate, wav)，无分块流——done=true 一帧交付。

用法（由 src/engines/indextts-binding.ts spawn，cwd 无要求）：
    <say-lab venv python> indextts-shim.py --repo <index-tts 仓库根> --models <checkpoints 目录>

为什么协议输出不走 sys.stdout：IndexTTS 核心类在 import、加载、推理全程向标准流 print
（">> starting inference..." 等），进程启动即把协议通道固定为 fd 1 的副本，
sys.stdout 整体改道 stderr，日志与协议帧从此分流。
"""

import argparse
import base64
import json
import os
import sys
import traceback


def main() -> int:
    parser = argparse.ArgumentParser(description="IndexTTS say shim")
    parser.add_argument("--repo", required=True, help="index-tts 仓库根（indextts 包以仓库形态在 sys.path 定位）")
    parser.add_argument("--models", required=True, help="checkpoints 目录（config.yaml 与权重落位根）")
    args = parser.parse_args()

    # 协议通道先于引擎 import 固定：import 期就可能 print
    protocol = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
    sys.stdout = sys.stderr

    def emit(obj) -> None:
        protocol.write(json.dumps(obj, ensure_ascii=False) + "\n")
        protocol.flush()

    try:
        if args.repo not in sys.path:
            sys.path.insert(0, args.repo)
        from indextts.infer_v2_5 import IndexTTS2

        # use_bf16 关闭：调研实证 MPS 强制 fp32（作者注释 bf16 在 MPS 更慢）；
        # device 缺省走引擎自动检测（cuda→xpu→mps→cpu，M3 Max 落 mps）
        model = IndexTTS2(cfg_path=os.path.join(args.models, "config.yaml"), model_dir=args.models)
        emit({
            "type": "ready",
            "engine": "indextts",
            "version": "2.5",
            "device": str(model.device),
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
            text = req["text"]
            # 零样本克隆引擎无参考不出声：缺参考按请求级错误回报（进程存活语义）
            ref = req.get("ref_audio_path")
            if not ref:
                raise KeyError("ref_audio_path")
            # 协议 text_lang 即引擎 lang：Node 侧自判 zh/en 下传，不依赖引擎侧检测
            lang = req.get("text_lang") or "zh"
            kwargs = {}
            duration_factor = req.get("duration_factor")
            if duration_factor is not None:
                kwargs["duration_factor"] = float(duration_factor)
            emo_alpha = req.get("emo_alpha")
            if emo_alpha is not None:
                kwargs["emo_alpha"] = float(emo_alpha)
            # 整句形态（stream_return 缺省 False + output_path=None）：返回 (sample_rate, wav) 或 None
            result = model.infer(ref, text, None, lang, **kwargs)
            if result is None:
                emit({"type": "error", "id": req_id, "message": "engine produced no audio"})
                continue
            sample_rate, wav_data = result
            # wav_data = int16 (samples, channels) 转置形态（引擎按 Gradio 约定给出）；单声道拍平后编码
            import numpy as np

            samples = np.asarray(wav_data).astype("<i2").reshape(-1)
            emit({
                "type": "audio",
                "id": req_id,
                "pcm": base64.b64encode(samples.tobytes()).decode("ascii"),
                "sample_rate": int(sample_rate),
                "done": True,
            })
        except KeyError as e:
            emit({"type": "error", "id": req_id, "message": f"missing request field: {e}"})
        except Exception as e:  # noqa: BLE001 — 单请求失败按 error 回报，进程保持存活
            # traceback 走 stderr（协议面保持纯净）：根因现场靠这里落到对端日志
            traceback.print_exc()
            emit({"type": "error", "id": req_id, "message": f"{type(e).__name__}: {e}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
