#!/usr/bin/env python3
"""GPT-SoVITS 子进程协议 shim（引擎层 v2 协议钉版，S3）。

api_v2 同核（GPT_SoVITS.TTS_infer_pack.TTS）的 stdin/stdout JSON 行薄封装：
请求/响应字段与 api_v2 /tts 一比一同名（snake_case），传输层从 HTTP 换成行管道。
协议契约见 say 仓 docs/engine-protocol.md，改帧格式两处（本文件与
src/engines/gptsovits-protocol.ts）同改。

用法（由 src/engines/gptsovits-binding.ts spawn，cwd 无要求）：
    <say-lab venv python> gptsovits-shim.py --repo <GPT-SoVITS 仓库根>          # per-call 形态（stdin/stdout 行管道）
    <say-lab venv python> gptsovits-shim.py --repo ... --daemon [--idle-minutes N]  # 常驻形态（unix socket 服务多 CLI 连接）

两形态帧协议逐字一致（engine-protocol v1），仅传输层不同：daemon 的 ready 帧多带
protocol 与 weights_fingerprint 版本键字段，供 Node 侧握手识别过期常驻进程。

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
# 那正是握手要拒的对象。per-call 形态不携带（帧消费面忽略未知字段：帧不动、只换传输）。
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
    粒度对安装事件足够。升级重装重写 marker → mtime 变 → 旧 daemon 握手失效自动重拉。
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


def serve_daemon(args) -> int:
    """常驻服务形态：unix socket 先 bind 再加载模型，帧走 socket（协议面与 per-call 逐字一致）。

    生命周期钉版：bind 成功即写 pid 文件（外部过期 daemon 的 kill 句柄）；加载完成向所有
    在位连接广播 ready（含版本键三元组），失败广播 fatal 后以 1 退出；闲置超阈且无在途
    工作时自退回收内存；SIGTERM 置标志优雅自退（在途请求由 Node 侧 EOF 收敛降级）。
    stdio 先重定向 daemon.log：拉起方 CLI 随时退出并关闭继承管道，引擎/库的任何 stderr
    写向死管道会以 BrokenPipeError 杀掉 daemon——日志面必须自持。协议帧不占 stdio。
    推理严格单飞串行：一个 worker 线程消费跨连接队列，并发由排队消化（多 pipeline
    并行在 128GB 统一内存上互抢带宽、实测更慢）。
    """
    import errno
    import queue
    import signal
    import socket
    import threading
    import time

    lab = os.path.abspath(args.lab) if args.lab else os.path.dirname(os.path.abspath(args.repo))
    sock_path = os.path.join(lab, "daemon.sock")
    pid_path = os.path.join(lab, "daemon.pid")
    idle_s = max(1.0, args.idle_minutes * 60.0)

    log_file = open(os.path.join(lab, "daemon.log"), "a", encoding="utf-8")
    os.dup2(log_file.fileno(), 1)
    os.dup2(log_file.fileno(), 2)
    sys.stdout = sys.stderr = log_file  # Python 层 print 同样落日志，与 C 层写 fd 2 的库输出同处

    def log(msg: str) -> None:
        print(f"[daemon {time.strftime('%m-%d %H:%M:%S')}] {msg}", flush=True)

    # bind 前判活：EADDRINUSE 且可连 = 已有活体 daemon，输家退出 3（拉起竞态的 S1 基础裁决，
    # connect 轮询等待赢家就绪归后续完善）；EADDRINUSE 且不可连 = 残file，清掉重 bind
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
        server.bind(sock_path)
    server.listen(16)
    with open(pid_path, "w", encoding="utf-8") as f:
        f.write(f"{os.getpid()}\n")
    log(f"bind {sock_path}（pid {os.getpid()}，闲置阈值 {args.idle_minutes} 分钟）")

    clients: list[dict] = []  # {"conn": socket, "ready_sent": bool}：广播与 accept 的 ready 恰发一次
    clients_lock = threading.Lock()
    work: "queue.Queue[tuple[dict, bytes]]" = queue.Queue()
    stop_flag = threading.Event()
    loaded = threading.Event()
    engine_info: dict = {}
    last_activity = [time.monotonic()]

    def send_frame(client: dict, obj) -> None:
        try:
            client["conn"].sendall((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
        except OSError:
            pass  # 对端已离场：帧丢弃即可，Node 侧按 EOF 收敛降级，不让死连接杀服务

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
        if req.get("type") == "shutdown":  # 显式收割通道：等价 SIGTERM（pid 文件丢失时仍可退）
            log("收到 shutdown，优雅退出")
            stop_flag.set()
            return
        req_id = req.get("id", -1)
        pipeline = engine_info["pipeline"]
        import numpy as np  # 模块级缓存 import：零成本，int16 判定与 per-call 的 np.int16 同源
        started = time.monotonic()
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
                send_frame(client, {"type": "error", "id": req_id, "message": "engine produced no audio"})
                return
            if audio.dtype != np.int16:
                audio = audio.astype(np.int16)
            send_frame(client, {
                "type": "audio",
                "id": req_id,
                "pcm": base64.b64encode(audio.tobytes()).decode("ascii"),
                "sample_rate": sample_rate,
                "done": True,
            })
            log(f"请求 {req_id} 完成，耗时 {time.monotonic() - started:.2f}s")
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
        if already_ready:  # 加载完成后才连上的：立即补 ready（广播只覆盖加载期已在位的连接）
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
                if line.strip():
                    work.put((client, line))
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
            except socket.timeout:  # 3.10+ 里它就是 TimeoutError；写子类名兼容更老解释器
                # 闲置收割判据：超阈、加载已完成、队列排空且无在位连接（CLI 还连着说明有人活着）
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
            if not loaded.is_set():
                stop_flag.wait(0.2)
                continue
            try:
                client, raw = work.get(timeout=0.2)
            except queue.Empty:
                continue
            process_request(client, raw)
            last_activity[0] = time.monotonic()

    def load_engine() -> None:
        try:
            os.chdir(args_repo)  # TTS_Config 的相对权重路径按 cwd 解析，且首次构造会写 tts_infer.yaml
            sys.path.insert(0, args_repo)
            sys.path.insert(0, os.path.join(args_repo, "GPT_SoVITS"))
            import numpy as np  # noqa: F401 — int16 判定用，加载期即验证依赖完整

            from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config

            # CPU 档显式钉死（调研实证 MPS 全线慢 1.5-2 倍弃用）；权重走仓库默认 v2 预训练路径
            config = TTS_Config({"custom": {"device": "cpu", "is_half": False, "version": "v2"}})
            pipeline = TTS(config)
            engine_info["pipeline"] = pipeline
            engine_info["ready"] = {
                "type": "ready",
                "engine": "gptsovits",
                "version": str(config.version),
                "device": str(config.device),
                "protocol": PROTOCOL_VERSION,
                "weights_fingerprint": weights_fingerprint(lab),
            }
            loaded.set()
            broadcast(engine_info["ready"])
            log(f"模型就绪 version={config.version} device={config.device} weights={engine_info['ready']['weights_fingerprint'][:12]}…")
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
    args_repo = os.path.abspath(args.repo)
    threading.Thread(target=accept_loop, daemon=True).start()
    threading.Thread(target=worker_loop, daemon=True).start()
    load_engine()  # 主线程加载：accept 已开闸，加载期连接排队等待，就绪即广播
    while not stop_flag.is_set():
        time.sleep(0.2)
    cleanup()
    # 退出码语义：加载失败=1（Node 侧经 fatal 帧与 EOF 感知），闲置/SIGTERM 优雅自退=0
    return 1 if engine_info.get("fatal") else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="GPT-SoVITS say shim")
    parser.add_argument("--repo", required=True, help="GPT-SoVITS 仓库根（权重相对路径与配置写盘按它解析）")
    parser.add_argument("--lab", default=None, help="say-lab 引擎目录（daemon 形态 sock/pid/log 与权重指纹落点）；缺省按 repo 父目录推导")
    parser.add_argument("--print-fingerprint", action="store_true", help="只打印权重指纹并退出（排障与公式对拍用，不触引擎 import）")
    parser.add_argument("--daemon", action="store_true", help="常驻服务形态：bind unix socket 经 JSONL 帧服务多 CLI 连接，闲置自收割")
    parser.add_argument("--idle-minutes", type=float, default=15.0, help="daemon 闲置收割阈值（分钟），无请求无连接超阈即自退")
    args = parser.parse_args()

    if args.print_fingerprint:
        lab = os.path.abspath(args.lab) if args.lab else os.path.dirname(os.path.abspath(args.repo))
        print(weights_fingerprint(lab))
        return 0

    if args.daemon:
        return serve_daemon(args)

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
