#!/usr/bin/env python3
"""FireRedTTS3 整句协议 shim（引擎层 v2 协议复用，S6）。

FireRedTTS3（Base 类）同步 API 的 stdin/stdout JSON 行薄封装，
协议契约见 say 仓 docs/engine-protocol.md（S3 钉版），本文件与
src/engines/gptsovits-protocol.ts 是同一契约的另一侧执行面。

引擎侧差异点（相对 indextts/voxcpm/gptsovits shim）：
- 克隆走 Base 类 FireRedTTS3.generate：Instruct 的 generate_tts 存在上游解包
  bug（core.py 中 backend 返回 2 元组被按 3 元组解包，ICL 克隆必崩），本 shim
  不 import Instruct 类规避；若上游修复且需要 Instruct 指令面
  （voice_design / acoustic_edit），经协议新增可选字段另立扩展。
- language tag 是首字母大写全称白名单（MULTI_LANG_TAGS：Chinese/English/...），
  协议 text_lang（zh/en）在 shim 内映射，不透传原值。
- prompt_text 必带：FireRed 克隆质量依赖参考转写与音频内容严格对应，缺转写按
  请求级错误回报（进程存活语义）。
- FIRERED_DEVICE：设备由 Node 侧 spawn env 注入（darwin 默认 mps），shim 不读
  不判——上游硬编码 cuda 已被安装面 patch 参数化，缺省仍保留 cuda 行为。
- use_fasttext=False：Node 侧总显式传 language，自动判定链路不触达，安装面
  省去 fasttext 语种模型下载与 numpy 2.x 兼容坑。

用法（由 src/engines/firered-binding.ts spawn，cwd 无要求）：
    <say-lab venv python> firered-shim.py --repo <FireRedTTS3 仓库根> --models <pretrained_model_dir>

单请求产出单帧：generate 整句返回 (tensor, sr)，done=true 一帧交付。

为什么协议输出不走 sys.stdout：FireRedTTS3 核心在 import、加载、推理全程向
标准流 print，进程启动即把协议通道固定为 fd 1 的副本，sys.stdout 整体改道
stderr，日志与协议帧从此分流。
"""

import argparse
import base64
import json
import os
import sys
import traceback


def main() -> int:
    parser = argparse.ArgumentParser(description="FireRedTTS3 say shim")
    parser.add_argument("--repo", required=True, help="FireRedTTS3 仓库根（fireredtts3 包以仓库形态在 sys.path 定位）")
    parser.add_argument("--models", required=True, help="pretrained_model_dir（fireredtts3_base 等子目录的父目录）")
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
        from fireredtts3.core import FireRedTTS3

        model = FireRedTTS3(args.models, use_fasttext=False)
        emit({
            "type": "ready",
            "engine": "firered",
            "version": "3",
            "device": str(model.device),
        })
    except Exception as e:  # noqa: BLE001 — 加载期任何失败都按 fatal 报给协议对端
        emit({"type": "fatal", "message": f"{type(e).__name__}: {e}"})
        return 1

    import torchaudio

    # 协议 text_lang（zh/en）→ FireRed 白名单 tag（MULTI_LANG_TAGS 首字母大写全称）；
    # 白名单外断言崩进程，映射表钉死两项与 Node 侧 detectTextLang 的产出域对齐
    LANG_TAGS = {"zh": "Chinese", "en": "English"}

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
            ref = req.get("ref_audio_path")
            if not ref:
                raise KeyError("ref_audio_path")
            prompt_text = req.get("prompt_text")
            if not prompt_text:
                raise KeyError("prompt_text")
            language = LANG_TAGS.get(req.get("text_lang") or "zh")
            if language is None:
                raise ValueError(f"unsupported text_lang: {req.get('text_lang')}")
            # 参考音频多声道折单声道（gradio demo 同款动作），sr 由 torchaudio 实测透出
            wav, sr = torchaudio.load(ref)
            wav = wav.mean(dim=0, keepdim=True)
            gen_audio, gen_sr = model.generate(
                text,
                language=language,
                prompt_text=prompt_text,
                prompt_audio=wav,
                prompt_audio_sr=int(sr),
            )
            # float32 → int16 LE（协议面契约）：先夹 [-1,1] 再缩放，codec 偶发 overshoot 的
            # 超幅样本不 clip 会按模 2^16 回绕成满幅反向爆音（astype 是回绕不是饱和）
            import numpy as np

            samples = (np.clip(gen_audio.squeeze(0).detach().cpu().numpy(), -1.0, 1.0) * 32767.0).astype("<i2").reshape(-1)
            emit({
                "type": "audio",
                "id": req_id,
                "pcm": base64.b64encode(samples.tobytes()).decode("ascii"),
                "sample_rate": int(gen_sr),
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
