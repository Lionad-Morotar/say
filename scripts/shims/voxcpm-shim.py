#!/usr/bin/env python3
"""VoxCPM 流式协议 shim（引擎层 v2 协议复用，S4）。

VoxCPM.generate_streaming（首包 0.2-0.5s / 48kHz）的 JSON 行薄封装，
协议契约见 say 仓 docs/engine-protocol.md（S3 钉版），本文件与
src/engines/gptsovits-protocol.ts 是同一契约的两侧执行面。

流式块发送约定：generate_streaming 的生成器只有再取一次才知耗尽，故缓存上一块、
下一块到达才发出（done=false），耗尽后以 done=true 发出最后缓存块；单块流即一帧
done=true；零块流按 error 帧回报（进程存活语义）。

用法（由 src/engines/voxcpm-binding.ts spawn，cwd 无要求）：
    <say-lab venv python> voxcpm-shim.py --models <VoxCPM 模型资产目录>                    # per-call 形态（stdin/stdout 行管道）
    <say-lab venv python> voxcpm-shim.py --models ... --daemon [--idle-minutes N]         # 常驻形态（unix socket 服务多 CLI 连接）

两形态帧协议逐字一致（engine-protocol v1），仅传输层不同：daemon 的 ready 帧多带
protocol 与 weights_fingerprint 版本键字段，供 Node 侧握手识别过期常驻进程。
daemon 形态的生命周期钉版与 gptsovits 同源（热启动 S1 先钉、S3/S5 同构复制）：
bind 先于加载、pid/log 落位、有界队列 4 拒转、单飞串行、idle 15min 自收割、SIGTERM 优雅退。
idle 阈按票 03 per-engine 表：voxcpm=15（4.6GB 档，burst 间隔容忍度高于 firered）。
daemon 是四引擎里唯一的流式形态：process_request 把块序列逐帧写回同一连接，
done 尾帧到达即请求终结（与 per-call 的帧序完全一致）。

为什么协议输出不走 sys.stdout：VoxCPM 核心类与依赖库的日志不可预期地混入标准流，
per-call 进程启动即把协议通道固定为 fd 1 的副本，sys.stdout 整体改道 stderr，
日志与协议帧从此分流（daemon 形态帧走 socket、stdout 整体重定向 daemon.log）。
"""

import argparse
import base64
import hashlib
import json
import os
import sys
import traceback

# 握手版本键的协议常量：daemon 形态 ready 帧携带，Node 侧（src/engines/daemon-session.ts）校验。
# 与仓内 TS 侧常量同步 bump（协议面跨引擎共用一个版本轴，非引擎私有）。
PROTOCOL_VERSION = "2"

# 队满拒转的 message：与 TS 侧 DAEMON_QUEUE_FULL_MESSAGE 逐字一致（源文本对拍测试钉死）。
# 语义是容量事件不是请求失败：Node 侧按此前缀归入基础设施失败降级 per-call，daemon 与连接都不动。
QUEUE_FULL_MESSAGE = "daemon queue full"

# 权重指纹的磁盘投影清单：install-engine 主权重面的文件级投影（size+mtime），
# 与 scripts/lib/engine-manifest.mjs VOXCPM.weights 逐条一致（manifest 增删两处同改；
# 无 default 资产嗓——voxcpm 的 default 是 control 文本形态，无 prompt wav 入投影）。
# 与 TS 侧 VOXCPM_WEIGHT_MARKERS 逐条对拍钉死——漂移会致每次握手失败、静默永久降级 per-call，
# 由 test/daemon-fingerprint.test.ts 双实现对拍守住。
WEIGHT_MARKERS = [
    "models/model.safetensors",
    "models/audiovae.pth",
    "models/config.json",
    "models/tokenizer.json",
    "models/tokenizer_config.json",
    "models/special_tokens_map.json",
    "models/tokenization_voxcpm2.py",
]


class NoAudioError(Exception):
    """引擎零块产出：协议面按 error 帧原文案 "engine produced no audio" 回报（两形态共享的既有钉版语义）。"""


def weights_fingerprint(lab_dir: str) -> str:
    """marker 清单（rel 升序）逐条 `rel|size|mtime_ms`（缺项 `rel|missing|0`）换行 join 的 sha256。

    公式与 gptsovits/indextts/firered shim 及 TS 侧 weightsFingerprint 逐字节同构（跨语言对拍测试钉死）；
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
    """say-lab 引擎目录：--lab 显式值优先，缺省按 models 父目录推导（labDir/models 安装形态）。"""
    if args.lab:
        return os.path.abspath(args.lab)
    return os.path.dirname(os.path.abspath(args.models))


def load_engine(models: str, device):
    """引擎装配：denoiser 关闭（角色 ref 资产已是干净干音，省 zipenhancer 依赖面——调研集成口径）。

    numpy/voxcpm 在函数体内延迟 import：--print-fingerprint 协议面与 daemon 的 bind 阶段
    都不该被引擎依赖树绑死（缺依赖在加载期 fatal 才暴露，per-call 同语义）。
    """
    import numpy as np  # noqa: F401 — 桩与真机面统一在此校验依赖（chunk_to_pcm 自带局部 import）
    from voxcpm import VoxCPM

    return VoxCPM.from_pretrained(os.path.abspath(models), load_denoiser=False, optimize=True, device=device)


def chunk_to_pcm(chunk) -> str:
    # float32 [-1,1] → int16 LE：与 wav.ts encodeWav 的乘 32767 同向，量化误差不叠加
    import numpy as np

    samples = np.clip(np.asarray(chunk, dtype=np.float32).squeeze(), -1.0, 1.0)
    int16 = (samples * 32767.0).astype("<i2")
    return base64.b64encode(int16.tobytes()).decode("ascii")


def stream_pcm(model, req: dict, timesteps: int):
    """请求 dict → (pcm_b64, done) 帧序列生成器。两形态共享的请求处理本体。

    错误语义与 per-call 既有面逐字保持：缺 text 抛 KeyError（框架转 missing request field）、
    零块流抛 NoAudioError（框架转协议原文案）；control 与文本同通道（括号前缀内联 text 首部）；
    prompt_wav_path/prompt_text 引擎强制成对，协议空串视同缺席即 voice creation。
    坏例重试（retry_badcase）在流式形态被引擎自动禁用：部分块已产出，重试无从谈起。
    """
    text = req["text"]
    control = req.get("control")
    if control:
        text = f"({control}){text}"
    ref = req.get("ref_audio_path") or None
    prompt = req.get("prompt_text") or None
    kwargs = {"cfg_value": 2.0, "inference_timesteps": int(timesteps)}
    if ref is not None and prompt is not None:
        kwargs["prompt_wav_path"] = ref
        kwargs["prompt_text"] = prompt
    prev = None
    for chunk in model.generate_streaming(text, **kwargs):
        if prev is not None:
            yield chunk_to_pcm(prev), False
        prev = chunk
    if prev is None:
        raise NoAudioError("engine produced no audio")
    yield chunk_to_pcm(prev), True


def serve_daemon(args) -> int:
    """常驻服务形态：unix socket 先 bind 再加载模型，帧走 socket（协议面与 per-call 逐字一致）。

    生命周期与 gptsovits/indextts/firered serve_daemon 同构（热启动 S1 钉版、S3/S5 复制），
    差异只在引擎装配与请求段：加载走 voxcpm.VoxCPM.from_pretrained，
    请求走 generate_streaming 流式形态（多帧写回同一连接，done 尾帧终结）。
    idle 默认 15min——票 03 per-engine 表钉 voxcpm=15。
    ready 帧的 version 用运行时类名（非字面钉版）：architecture 漂移时类名与 config.json
    指纹双路都会击穿握手，过期 daemon 自动重拉，无静默错配面。
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

    def send_frame(client: dict, obj) -> bool:
        try:
            client["conn"].sendall((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
            return True
        except OSError:
            return False  # 对端已离场：帧丢弃即可，Node 侧按 EOF 收敛降级

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
        model = engine_info["model"]
        started = time.monotonic()
        frames = 0
        aborted = False
        try:
            # 流式多帧：块到达即写回同一连接，done 尾帧终结（与 per-call emit 序逐字一致）。
            # 发送失败 = 对端已离场：立即中止生成（生成器 close 掐断 generate_streaming）——
            # 单飞位不该为无主请求烧完整句，否则断连到句尾之间排队位全被占、新请求吃队满
            stream = stream_pcm(model, req, args.timesteps)
            try:
                for pcm, done in stream:
                    if not send_frame(client, {"type": "audio", "id": req_id, "pcm": pcm, "sample_rate": engine_info["sample_rate"], "done": done}):
                        aborted = True
                        break
                    frames += 1
            finally:
                stream.close()
            if aborted:
                log(f"请求 {req_id} 对端离场：{frames} 帧后中止生成，耗时 {time.monotonic() - started:.2f}s")
            else:
                log(f"请求 {req_id} 完成：{frames} 帧，耗时 {time.monotonic() - started:.2f}s")
        except KeyError as e:
            send_frame(client, {"type": "error", "id": req_id, "message": f"missing request field: {e}"})
        except NoAudioError:
            send_frame(client, {"type": "error", "id": req_id, "message": "engine produced no audio"})
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
            model = load_engine(args.models, args.device)

            engine_info["model"] = model
            engine_info["sample_rate"] = int(model.tts_model.sample_rate)
            engine_info["ready"] = {
                "type": "ready",
                "engine": "voxcpm",
                "version": type(model.tts_model).__name__,
                "device": str(next(model.tts_model.parameters()).device),
                "protocol": PROTOCOL_VERSION,
                "weights_fingerprint": weights_fingerprint(lab),
                "pid": os.getpid(),  # kill 归属核对：Node 侧对 pid 文件动手前比对本自述，防 pid 复用误杀
            }
            loaded.set()
            broadcast(engine_info["ready"])
            log(f"模型就绪 device={engine_info['ready']['device']} weights={engine_info['ready']['weights_fingerprint'][:12]}…")
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
    parser = argparse.ArgumentParser(description="VoxCPM say shim")
    parser.add_argument("--models", default=None, help="VoxCPM 模型资产目录（from_pretrained 的本地目录形态）；per-call/daemon 形态必带，print-fingerprint 不需要")
    parser.add_argument("--lab", default=None, help="say-lab 引擎目录（daemon 形态 sock/pid/log 与权重指纹落点）；缺省按 models 父目录推导")
    parser.add_argument("--print-fingerprint", action="store_true", help="只打印权重指纹并退出（排障与公式对拍用，不触引擎 import）")
    parser.add_argument("--daemon", action="store_true", help="常驻服务形态：bind unix socket 经 JSONL 帧服务多 CLI 连接，闲置自收割")
    parser.add_argument("--idle-minutes", type=float, default=15.0, help="daemon 闲置收割阈值（分钟），无请求无连接超阈即自退（票 03：voxcpm 档 15）")
    parser.add_argument("--device", default=None, help="推理设备（缺省 auto；M3 Max 实证 auto→MPS+float32）")
    parser.add_argument("--timesteps", type=int, default=4, help="inference_timesteps（调研实测 4 为最优口径）")
    args = parser.parse_args()

    if args.print_fingerprint:
        if not args.lab and not args.models:
            parser.error("--print-fingerprint 需要 --lab 或 --models 其一以定位 say-lab 引擎目录")
        print(weights_fingerprint(resolve_lab_dir(args)))
        return 0

    if args.models is None:
        parser.error("--models 必填（per-call 与 daemon 形态都需要模型资产目录）")

    if args.daemon:
        return serve_daemon(args)

    # 协议通道先于引擎 import 固定：import 期就可能 print
    protocol = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
    sys.stdout = sys.stderr

    def emit(obj) -> None:
        protocol.write(json.dumps(obj, ensure_ascii=False) + "\n")
        protocol.flush()

    try:
        model = load_engine(args.models, args.device)
        emit({
            "type": "ready",
            "engine": "voxcpm",
            "version": type(model.tts_model).__name__,
            "device": str(next(model.tts_model.parameters()).device),
        })
    except Exception as e:  # noqa: BLE001 — 加载期任何失败都按 fatal 报给协议对端
        emit({"type": "fatal", "message": f"{type(e).__name__}: {e}"})
        return 1

    sample_rate = int(model.tts_model.sample_rate)

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
            for pcm, done in stream_pcm(model, req, args.timesteps):
                emit({"type": "audio", "id": req_id, "pcm": pcm, "sample_rate": sample_rate, "done": done})
        except KeyError as e:
            emit({"type": "error", "id": req_id, "message": f"missing request field: {e}"})
        except NoAudioError:
            emit({"type": "error", "id": req_id, "message": "engine produced no audio"})
        except Exception as e:  # noqa: BLE001 — 单请求失败按 error 回报，进程保持存活
            # traceback 走 stderr（协议面保持纯净）：根因现场靠这里落到对端日志
            traceback.print_exc()
            emit({"type": "error", "id": req_id, "message": f"{type(e).__name__}: {e}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
