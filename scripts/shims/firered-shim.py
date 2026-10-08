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
  协议 text_lang（zh/en/ja）在 shim 内映射，不透传原值。
- prompt_text 必带：FireRed 克隆质量依赖参考转写与音频内容严格对应，缺转写按
  请求级错误回报（进程存活语义）。
- FIRERED_DEVICE：设备由 Node 侧 spawn env 注入（darwin 默认 mps），shim 不读
  不判——上游硬编码 cuda 已被安装面 patch 参数化，缺省仍保留 cuda 行为。
- use_fasttext=False：Node 侧总显式传 language，自动判定链路不触达，安装面
  省去 fasttext 语种模型下载与 numpy 2.x 兼容坑。

用法（由 src/engines/firered-binding.ts spawn，cwd 无要求）：
    <say-lab venv python> firered-shim.py --repo <FireRedTTS3 仓库根> --models <pretrained_model_dir>                # per-call 形态（stdin/stdout 行管道）
    <say-lab venv python> firered-shim.py --repo ... --models ... --daemon [--idle-minutes N]                       # 常驻形态（unix socket 服务多 CLI 连接）

两形态帧协议逐字一致（engine-protocol v1），仅传输层不同：daemon 的 ready 帧多带
protocol 与 weights_fingerprint 版本键字段，供 Node 侧握手识别过期常驻进程。
daemon 形态的生命周期钉版与 gptsovits 同源（热启动 S1 先钉、S3/S5 同构复制）：
bind 先于加载、pid/log 落位、有界队列 4 拒转、单飞串行、idle 5min 自收割、SIGTERM 优雅退。
idle 阈按票 03 per-engine 表：firered 39GB 档内存占用，用完尽快让出。

为什么协议输出不走 sys.stdout：FireRedTTS3 核心在 import、加载、推理全程向
标准流 print，进程启动即把协议通道固定为 fd 1 的副本，sys.stdout 整体改道
stderr，日志与协议帧从此分流（daemon 形态则整体重定向 daemon.log）。
"""

import argparse
import base64
import hashlib
import json
import os
import sys
import traceback
import wave

# 握手版本键的协议常量：daemon 形态 ready 帧携带，Node 侧（src/engines/daemon-session.ts）校验。
# 与仓内 TS 侧常量同步 bump（协议面跨引擎共用一个版本轴，非引擎私有）。
PROTOCOL_VERSION = "2"

# 队满拒转的 message：与 TS 侧 DAEMON_QUEUE_FULL_MESSAGE 逐字一致（源文本对拍测试钉死）。
# 语义是容量事件不是请求失败：Node 侧按此前缀归入基础设施失败降级 per-call，daemon 与连接都不动。
QUEUE_FULL_MESSAGE = "daemon queue full"

# 权重指纹的磁盘投影清单：install-engine 主权重面的文件级投影（size+mtime），
# 与 scripts/lib/engine-manifest.mjs FIRERED.weights 逐条一致（含 prompts/prompt_2.wav
# default 嗓参考——与 indextts 把示例参考纳入投影的先例同构；manifest 增删两处同改）。
# 与 TS 侧 FIRERED_WEIGHT_MARKERS 逐条对拍钉死——漂移会致每次握手失败、静默永久降级 per-call，
# 由 test/daemon-fingerprint.test.ts 双实现对拍守住。
WEIGHT_MARKERS = [
    "models/FireRedTTS3/fireredtts3_base/model.safetensors",
    "models/FireRedTTS3/fireredtts3_base/config.json",
    "models/FireRedTTS3/fireredtts3_instruct/model.safetensors",
    "models/FireRedTTS3/fireredtts3_instruct/config.json",
    "models/FireRedTTS3/redae/model.safetensors",
    "models/FireRedTTS3/redae/config.json",
    "models/FireRedTTS3/campp/campplus_voxceleb.bin",
    "models/FireRedTTS3/text_tokenizer/tokenizer.json",
    "models/FireRedTTS3/text_tokenizer/tokenizer_config.json",
    "models/FireRedTTS3/text_tokenizer/vocab.json",
    "prompts/prompt_2.wav",
]


def weights_fingerprint(lab_dir: str) -> str:
    """marker 清单（rel 升序）逐条 `rel|size|mtime_ms`（缺项 `rel|missing|0`）换行 join 的 sha256。

    公式与 gptsovits/indextts shim 及 TS 侧 weightsFingerprint 逐字节同构（跨语言对拍测试钉死）；
    升级重装重写权重文件 → mtime 变 → 旧 daemon 握手失效自动重拉。
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


def resolve_lab_dir(args) -> str:
    """say-lab 引擎目录：--lab 显式值优先，缺省按 repo 父目录推导（labDir/FireRedTTS3 安装形态）。"""
    if args.lab:
        return os.path.abspath(args.lab)
    return os.path.dirname(os.path.abspath(args.repo))


def load_engine(repo: str, models: str):
    """引擎装配：repo 入 sys.path → Base 类构造（Instruct 类不 import，上游解包 bug 规避面不变）。"""
    repo = os.path.abspath(repo)
    if repo not in sys.path:
        sys.path.insert(0, repo)
    from fireredtts3.core import FireRedTTS3

    return FireRedTTS3(models, use_fasttext=False)


# 协议 text_lang（zh/en/ja）→ FireRed 白名单 tag（MULTI_LANG_TAGS 首字母大写全称）；
# 白名单外断言崩进程，映射表钉死三项与 Node 侧 detectTextLang 的产出域对齐
LANG_TAGS = {"zh": "Chinese", "en": "English", "ja": "Japanese"}


def load_wav_tensor(path: str):
    """wav → (float32 tensor (1,T), sr)。torchaudio.load 的零后端替身：
    torchaudio 2.8 的 macOS wheel 不带 IO 后端（list_audio_backends 为空），
    soundfile 也不在引擎依赖面；参考音频恒为 16bit PCM wav（音源规范），
    标准库 wave + numpy 覆盖，多声道折单声道（gradio demo 同款动作）。
    引擎内部的 resample 走 torchaudio.functional（纯 tensor 运算，无后端依赖）。

    torch/numpy 在函数体内延迟 import：per-call 与 daemon 两形态共享本函数，
    协议面（--print-fingerprint）与 daemon 的 bind 阶段都不该被引擎依赖树绑死——
    缺依赖在首次请求才暴露，归请求级错误而非进程级闪退。
    """
    import numpy as np
    import torch

    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        channels = w.getnchannels()
        width = w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if width != 2:
        raise ValueError(f"unsupported wav sample width: {width * 8}bit（参考音频预期 16bit PCM）")
    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    return torch.from_numpy(samples).unsqueeze(0), sr


def synthesize(model, req: dict):
    """请求 dict → (sample_rate, int16 单声道 samples)。两形态共享的请求处理本体。

    错误语义与 per-call 既有面逐字保持：缺字段 KeyError（框架转 missing request field）、
    语言白名单外 ValueError、引擎无产出抛错；帧编码由调用方按各形态的传输层做。
    """
    import numpy as np

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
    # 参考音频由 shim 加载为 tensor（零后端替身），sr 实测透出
    wav, sr = load_wav_tensor(ref)
    gen_audio, gen_sr = model.generate(
        text,
        language=language,
        prompt_text=prompt_text,
        prompt_audio=wav,
        prompt_audio_sr=int(sr),
    )
    # float32 → int16 LE（协议面契约）：先夹 [-1,1] 再缩放，codec 偶发 overshoot 的
    # 超幅样本不 clip 会按模 2^16 回绕成满幅反向爆音（astype 是回绕不是饱和）
    samples = (np.clip(gen_audio.squeeze(0).detach().cpu().numpy(), -1.0, 1.0) * 32767.0).astype("<i2").reshape(-1)
    return int(gen_sr), samples


def serve_daemon(args) -> int:
    """常驻服务形态：unix socket 先 bind 再加载模型，帧走 socket（协议面与 per-call 逐字一致）。

    生命周期与 gptsovits/indextts serve_daemon 同构（热启动 S1 钉版、S3/S5 复制），
    差异只在引擎装配与请求段：加载走 fireredtts3.core.FireRedTTS3（Base 类），
    请求走 generate() 整句形态（单帧 done 交付）。idle 默认 5min——票 03 per-engine
    表钉 firered=5（39GB 档内存占用，用完尽快让出）。
    """
    import errno
    import queue
    import signal
    import socket
    import threading
    import time

    lab = resolve_lab_dir(args)
    sock_path = os.path.join(lab, "daemon.sock")
    pid_path = os.path.join(lab, "daemon.pid")
    idle_s = max(1.0, args.idle_minutes * 60.0)

    log_file = open(os.path.join(lab, "daemon.log"), "a", encoding="utf-8")
    os.dup2(log_file.fileno(), 1)
    os.dup2(log_file.fileno(), 2)
    sys.stdout = sys.stderr = log_file  # Python 层 print 同样落日志，与引擎库的整屏 print 同处

    def log(msg: str) -> None:
        print(f"[daemon {time.strftime('%m-%d %H:%M:%S')}] {msg}", flush=True)

    # bind 前判活：EADDRINUSE 且可连 = 已有活体 daemon，输家退出 3；不可连 = 残file，清掉重 bind
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        server.bind(sock_path)
    except OSError as e:
        if e.errno != errno.EADDRINUSE:
            raise
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        probe.settimeout(0.5)
        try:
            probe.connect(sock_path)
            log("已有活体 daemon 在位，本次拉起退出（exit 3）")
            return 3
        except OSError:
            probe.close()
        os.remove(sock_path)
        try:
            server.bind(sock_path)
        except OSError as e2:
            if e2.errno == errno.EADDRINUSE:
                # unlink 重 bind 只许一次：二次仍被占 = 间隙被他人接管，与探针判负同态让位
                log("unlink 重 bind 仍被占（他人刚接管），本次拉起让位退出（exit 3）")
                return 3
            raise
    server.listen(16)
    with open(pid_path, "w", encoding="utf-8") as f:
        f.write(f"{os.getpid()}\n")
    log(f"bind {sock_path}（pid {os.getpid()}，闲置阈值 {args.idle_minutes} 分钟）")

    clients: list[dict] = []  # {"conn": socket, "ready_sent": bool}：广播与 accept 的 ready 恰发一次
    clients_lock = threading.Lock()
    # 有界排队：单飞在途之外的等待位上限 4（票 03/04 钉版），满员新请求收拒转帧转 per-call
    work: "queue.Queue[tuple[dict, bytes]]" = queue.Queue(maxsize=4)
    stop_flag = threading.Event()
    loaded = threading.Event()
    engine_info: dict = {}
    last_activity = [time.monotonic()]

    def send_frame(client: dict, obj) -> None:
        try:
            client["conn"].sendall((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
        except OSError:
            pass  # 对端已离场：帧丢弃即可，Node 侧按 EOF 收敛降级

    def broadcast(obj) -> None:
        with clients_lock:
            pending = [c for c in clients if not c["ready_sent"]]
            for c in pending:
                c["ready_sent"] = True
        for c in pending:
            send_frame(c, obj)

    def process_request(client: dict, raw: bytes) -> None:
        try:
            req = json.loads(raw)
        except json.JSONDecodeError as e:
            send_frame(client, {"type": "error", "id": -1, "message": f"bad request json: {e}"})
            return
        if req.get("type") == "shutdown":  # 显式收割通道：等价 SIGTERM
            log("收到 shutdown，优雅退出")
            stop_flag.set()
            return
        req_id = req.get("id", -1)
        # caller_pid 归因（S6）：id 是调用方进程内计数器，多 CLI 进程并发共号时完成行靠它指认发起者
        caller_pid = req.get("caller_pid")
        req_tag = f"请求 {req_id}" + (f"（来自 pid {caller_pid}）" if caller_pid is not None else "")
        model = engine_info["model"]
        started = time.monotonic()
        try:
            sample_rate, samples = synthesize(model, req)
            send_frame(client, {
                "type": "audio",
                "id": req_id,
                "pcm": base64.b64encode(samples.tobytes()).decode("ascii"),
                "sample_rate": sample_rate,
                "done": True,
            })
            log(f"{req_tag} 完成，耗时 {time.monotonic() - started:.2f}s")
        except KeyError as e:
            send_frame(client, {"type": "error", "id": req_id, "message": f"missing request field: {e}"})
        except Exception as e:  # noqa: BLE001 — 单请求失败按 error 回报，daemon 保持存活
            traceback.print_exc()
            send_frame(client, {"type": "error", "id": req_id, "message": f"{type(e).__name__}: {e}"})

    def read_conn(conn: socket.socket) -> None:
        client = {"conn": conn, "ready_sent": False}
        with clients_lock:
            clients.append(client)
            already_ready = bool(engine_info.get("ready"))
            if already_ready:
                client["ready_sent"] = True
        if already_ready:  # 加载完成后才连上的：立即补 ready
            send_frame(client, engine_info["ready"])
        buf = b""
        while not stop_flag.is_set():
            try:
                chunk = conn.recv(65536)
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    work.put_nowait((client, line))
                except queue.Full:
                    # 队满即拒：回固定 message 的 error 帧，连接不关、进程不动
                    try:
                        req_id = int(json.loads(line).get("id", -1))
                    except (ValueError, TypeError, AttributeError):
                        req_id = -1
                    send_frame(client, {"type": "error", "id": req_id, "message": QUEUE_FULL_MESSAGE})
                    continue
                last_activity[0] = time.monotonic()
        with clients_lock:
            if client in clients:
                clients.remove(client)
        try:
            conn.close()
        except OSError:
            pass

    def accept_loop() -> None:
        server.settimeout(1.0)
        while not stop_flag.is_set():
            try:
                conn, _ = server.accept()
            except socket.timeout:
                # 闲置收割判据：超阈、加载已完成、队列排空且无在位连接
                if (time.monotonic() - last_activity[0] > idle_s and loaded.is_set() and work.empty()):
                    with clients_lock:
                        idle = not clients
                    if idle:
                        log(f"闲置超过 {args.idle_minutes} 分钟，自收割退出")
                        stop_flag.set()
                        break
                continue
            except OSError:
                break
            threading.Thread(target=read_conn, args=(conn,), daemon=True).start()

    def worker_loop() -> None:
        while not stop_flag.is_set():
            try:
                client, raw = work.get(timeout=0.2)
            except queue.Empty:
                continue
            # 常驻 get 消除「先查 loaded 再 get」门控的消费盲区（ready 后头几路请求积压成伪队满）
            while not loaded.is_set():
                if stop_flag.is_set():
                    break
                loaded.wait(0.1)
            if not loaded.is_set():
                continue
            process_request(client, raw)
            last_activity[0] = time.monotonic()

    def load_engine_thread() -> None:
        try:
            model = load_engine(args.repo, args.models)

            # FIRERED_DEVICE 由 Node 侧 spawn env 注入（darwin 默认 mps）：daemon 进程与
            # per-call 同一条设备选择链，shim 不读不判
            engine_info["model"] = model
            engine_info["ready"] = {
                "type": "ready",
                "engine": "firered",
                "version": "3",
                "device": str(model.device),
                "protocol": PROTOCOL_VERSION,
                "weights_fingerprint": weights_fingerprint(lab),
                "pid": os.getpid(),  # kill 归属核对：Node 侧对 pid 文件动手前比对本自述，防 pid 复用误杀
            }
            loaded.set()
            broadcast(engine_info["ready"])
            log(f"模型就绪 device={model.device} weights={engine_info['ready']['weights_fingerprint'][:12]}…")
        except Exception as e:  # noqa: BLE001 — 加载期任何失败都是 fatal：报给对端后自退
            traceback.print_exc()
            log(f"加载失败，daemon 退出（exit 1）：{type(e).__name__}: {e}")
            engine_info["fatal"] = True
            stop_flag.set()
            broadcast({"type": "fatal", "message": f"{type(e).__name__}: {e}"})

    def cleanup() -> None:
        try:
            server.close()
        except OSError:
            pass
        for path in (sock_path, pid_path):
            try:
                os.remove(path)
            except OSError:
                pass

    signal.signal(signal.SIGTERM, lambda *_: (log("收到 SIGTERM，优雅退出"), stop_flag.set()))
    threading.Thread(target=accept_loop, daemon=True).start()
    threading.Thread(target=worker_loop, daemon=True).start()
    load_engine_thread()  # 主线程加载：accept 已开闸，加载期连接排队等待，就绪即广播
    while not stop_flag.is_set():
        time.sleep(0.2)
    cleanup()
    return 1 if engine_info.get("fatal") else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="FireRedTTS3 say shim")
    parser.add_argument("--repo", default=None, help="FireRedTTS3 仓库根（fireredtts3 包以仓库形态在 sys.path 定位）；per-call/daemon 形态必带，print-fingerprint 带 --lab 即可免")
    parser.add_argument("--models", default=None, help="pretrained_model_dir（fireredtts3_base 等子目录的父目录）；per-call/daemon 形态必带，print-fingerprint 不需要")
    parser.add_argument("--lab", default=None, help="say-lab 引擎目录（daemon 形态 sock/pid/log 与权重指纹落点）；缺省按 repo 父目录推导")
    parser.add_argument("--print-fingerprint", action="store_true", help="只打印权重指纹并退出（排障与公式对拍用，不触引擎 import）")
    parser.add_argument("--daemon", action="store_true", help="常驻服务形态：bind unix socket 经 JSONL 帧服务多 CLI 连接，闲置自收割")
    parser.add_argument("--idle-minutes", type=float, default=5.0, help="daemon 闲置收割阈值（分钟），无请求无连接超阈即自退（票 03：firered 档 5）")
    args = parser.parse_args()

    # 形态级参数校验（print-fingerprint 排障面不被合成参数绑架——lab 或 repo 其一可定位投影根）
    if args.print_fingerprint:
        if not args.lab and not args.repo:
            parser.error("--print-fingerprint 需要 --lab 或 --repo 其一以定位 say-lab 引擎目录")
        print(weights_fingerprint(resolve_lab_dir(args)))
        return 0

    if not args.repo:
        parser.error("--repo 必填（per-call 与 daemon 形态都需要仓库根定位 fireredtts3 包）")

    if args.daemon:
        if args.models is None:
            parser.error("--daemon 形态必须携带 --models（pretrained_model_dir）")
        return serve_daemon(args)

    if args.models is None:
        parser.error("per-call 形态必须携带 --models（pretrained_model_dir）")

    # 协议通道先于引擎 import 固定：import 期就可能 print
    protocol = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
    sys.stdout = sys.stderr

    def emit(obj) -> None:
        protocol.write(json.dumps(obj, ensure_ascii=False) + "\n")
        protocol.flush()

    try:
        model = load_engine(args.repo, args.models)
        emit({
            "type": "ready",
            "engine": "firered",
            "version": "3",
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
            sample_rate, samples = synthesize(model, req)
            emit({
                "type": "audio",
                "id": req_id,
                "pcm": base64.b64encode(samples.tobytes()).decode("ascii"),
                "sample_rate": sample_rate,
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
