#!/usr/bin/env python3
"""VoxCPM 流式协议 shim（引擎层 v2 协议复用，S4）。

VoxCPM.generate_streaming（首包 0.2-0.5s / 48kHz）的 stdin/stdout JSON 行薄封装，
协议契约见 say 仓 docs/engine-protocol.md（S3 钉版），本文件与
src/engines/gptsovits-protocol.ts 是同一契约的两侧执行面。

流式块发送约定：generate_streaming 的生成器只有再取一次才知耗尽，故缓存上一块、
下一块到达才发出（done=false），耗尽后以 done=true 发出最后缓存块；单块流即一帧
done=true；零块流按 error 帧回报（进程存活语义）。

用法（由 src/engines/voxcpm-binding.ts spawn，cwd 无要求）：
    <say-lab venv python> voxcpm-shim.py --models <VoxCPM 模型资产目录>

为什么协议输出不走 sys.stdout：VoxCPM 核心类与依赖库的日志不可预期地混入标准流，
进程启动即把协议通道固定为 fd 1 的副本，sys.stdout 整体改道 stderr，日志与协议帧从此分流。
"""

import argparse
import base64
import json
import os
import sys
import traceback


def main() -> int:
    parser = argparse.ArgumentParser(description="VoxCPM say shim")
    parser.add_argument("--models", required=True, help="VoxCPM 模型资产目录（from_pretrained 的本地目录形态）")
    parser.add_argument("--device", default=None, help="推理设备（缺省 auto；M3 Max 实证 auto→MPS+float32）")
    parser.add_argument("--timesteps", type=int, default=4, help="inference_timesteps（调研实测 4 为最优口径）")
    args = parser.parse_args()

    # 协议通道先于引擎 import 固定：import 期就可能 print
    protocol = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
    sys.stdout = sys.stderr

    def emit(obj) -> None:
        protocol.write(json.dumps(obj, ensure_ascii=False) + "\n")
        protocol.flush()

    try:
        import numpy as np

        from voxcpm import VoxCPM

        # denoiser 关闭：角色 ref 资产已是干净干音，省 zipenhancer 依赖面（调研集成面口径）
        model = VoxCPM.from_pretrained(os.path.abspath(args.models), load_denoiser=False, optimize=True, device=args.device)
        device = str(next(model.tts_model.parameters()).device)
        emit({
            "type": "ready",
            "engine": "voxcpm",
            "version": type(model.tts_model).__name__,
            "device": device,
        })
    except Exception as e:  # noqa: BLE001 — 加载期任何失败都按 fatal 报给协议对端
        emit({"type": "fatal", "message": f"{type(e).__name__}: {e}"})
        return 1

    sample_rate = int(model.tts_model.sample_rate)

    def chunk_to_pcm(chunk) -> str:
        # float32 [-1,1] → int16 LE：与 wav.ts encodeWav 的乘 32767 同向，量化误差不叠加
        samples = np.clip(np.asarray(chunk, dtype=np.float32).squeeze(), -1.0, 1.0)
        int16 = (samples * 32767.0).astype("<i2")
        return base64.b64encode(int16.tobytes()).decode("ascii")

    def emit_audio(req_id: int, chunk, done: bool) -> None:
        emit({"type": "audio", "id": req_id, "pcm": chunk_to_pcm(chunk), "sample_rate": sample_rate, "done": done})

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
            # control 指令与文本同通道（引擎形态：括号前缀内联 text 首部，无独立参数位）
            control = req.get("control")
            if control:
                text = f"({control}){text}"
            # 协议通用字段空串视同缺席；prompt_wav_path/prompt_text 引擎强制成对，同空即 voice creation
            ref = req.get("ref_audio_path") or None
            prompt = req.get("prompt_text") or None
            kwargs = {"cfg_value": 2.0, "inference_timesteps": int(args.timesteps)}
            if ref is not None and prompt is not None:
                kwargs["prompt_wav_path"] = ref
                kwargs["prompt_text"] = prompt
            prev = None
            # 坏例重试（retry_badcase）在流式形态被引擎自动禁用：部分块已产出，重试无从谈起
            for chunk in model.generate_streaming(text, **kwargs):
                if prev is not None:
                    emit_audio(req_id, prev, False)
                prev = chunk
            if prev is None:
                emit({"type": "error", "id": req_id, "message": "engine produced no audio"})
                continue
            emit_audio(req_id, prev, True)
        except KeyError as e:
            emit({"type": "error", "id": req_id, "message": f"missing request field: {e}"})
        except Exception as e:  # noqa: BLE001 — 单请求失败按 error 回报，进程保持存活
            # traceback 走 stderr（协议面保持纯净）：根因现场靠这里落到对端日志
            traceback.print_exc()
            emit({"type": "error", "id": req_id, "message": f"{type(e).__name__}: {e}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
