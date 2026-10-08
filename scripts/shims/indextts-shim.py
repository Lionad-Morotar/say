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
    <say-lab venv python> indextts-shim.py --repo <index-tts 仓库根> --models <checkpoints 目录>                          # per-call 形态（stdin/stdout 行管道）
    <say-lab venv python> indextts-shim.py --repo ... --models ... --daemon [--idle-minutes N]                              # 常驻形态（unix socket 服务多 CLI 连接）

两形态帧协议逐字一致（engine-protocol v1），仅传输层不同：daemon 的 ready 帧多带
protocol 与 weights_fingerprint 版本键字段，供 Node 侧握手识别过期常驻进程。
daemon 形态的生命周期钉版与 gptsovits 同源（热启动 S1 先钉、S3 同构复制）：
bind 先于加载、pid/log 落位、有界队列 4 拒转、单飞串行、idle 30min 自收割、SIGTERM 优雅退。

为什么协议输出不走 sys.stdout：IndexTTS 核心类在 import、加载、推理全程向标准流 print
（">> starting inference..." 等），进程启动即把协议通道固定为 fd 1 的副本，
sys.stdout 整体改道 stderr，日志与协议帧从此分流（daemon 形态则整体重定向 daemon.log）。
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

# 权重指纹的磁盘投影清单：install-engine 主权重面的文件级投影（size+mtime）。
# 与 TS 侧 INDEXTTS_WEIGHT_MARKERS 逐条一致——漂移会致每次握手失败、静默永久降级 per-call，
# 由 test/daemon-fingerprint.test.ts 双实现对拍钉死。
# auto 层（checkpoints/hf_cache 首跑自拉四件）刻意排除：那是引擎 fallback 链的运行时产物，
# 不是安装事件的投影，纳入会把引擎自拉噪声当权重变更（D2 裁决）。
WEIGHT_MARKERS = [
    "checkpoints/gpt.pth",
    "checkpoints/codec.pth",
    "checkpoints/s2mel.pth",
    "checkpoints/qwen0.6bemo4-merge/model.safetensors",
    "checkpoints/config.yaml",
    "checkpoints/feat1.pt",
    "checkpoints/feat2.pt",
    "checkpoints/wav2vec2bert_stats.pt",
    "checkpoints/multilingual_zh_ja_yue_char_del.tiktoken",
    "index-tts/examples/voice_01.wav",
]


def weights_fingerprint(lab_dir: str) -> str:
    """marker 清单（rel 升序）逐条 `rel|size|mtime_ms`（缺项 `rel|missing|0`）换行 join 的 sha256。

    公式与 gptsovits shim / TS 侧 weightsFingerprint 逐字节同构（跨语言对拍测试钉死）；
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


def load_engine_with_fastload(repo: str, report) -> object:
    """两形态共享的引擎装载装配：repo 入 sys.path → import 引擎模块 → 装 fastload patch。

    回落面精确为 install 装配窗口：patch 本体异常不阻断出声（回落未打补丁的原始加载）。
    打补丁后的类在构造期抛异常不在回落面内——回退重试需要还原属性表与全局 torch.load
    的干净命名空间（Python reload 语义不可靠）；该风险面由钉版安装（uv.lock）+ S4 验收
    套件（真引擎整构造路径的合成与红测用例）在升级当场拦截，失声形态走三级降级的系统嗓出口。
    applied 结果经 report 打自报行，落 daemon.log 或 stderr
    （取证锚点：被测运行时自报，非外部期望）。返回引擎模块对象（IndexTTS2 从其属性取——
    patch 换的正是这份属性表）。
    """
    repo = os.path.abspath(repo)
    if repo not in sys.path:
        sys.path.insert(0, repo)
    import indextts.infer_v2_5 as engine_mod

    try:
        import indextts_fastload

        info = indextts_fastload.install_fast_load_patch(engine_mod)
    except Exception as e:  # noqa: BLE001 — 装配失败回落原始加载，出声优先
        info = {"applied": False, "reason": f"install-failed: {type(e).__name__}: {e}", "patched": []}
    report(
        f"[fastload] applied={info['applied']} "
        f"patched={','.join(info['patched']) if info['patched'] else '-'} reason={info['reason']}"
    )
    return engine_mod


def serve_daemon(args) -> int:
    """常驻服务形态：unix socket 先 bind 再加载模型，帧走 socket（协议面与 per-call 逐字一致）。

    生命周期与 gptsovits serve_daemon 同构（热启动 S1 钉版、S3 复制），差异只在引擎装配：
    加载走 `indextts.infer_v2_5.IndexTTS2`（MPS 自动检测，bf16 关闭的既有裁决），
    请求走 `model.infer()` 整句形态（单帧 done 交付）。idle 默认 30min——票 03 per-engine
    表钉 indextts=30（zh 默认链高频 + 冷启动最贵 23s，burst 保温收益最大）。
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
        alive = False
        try:
            probe.connect(sock_path)
            alive = True
        except ConnectionRefusedError:
            # bind→listen 间隙：赢家已 bind 未 listen 时 connect 在探测面同样收拒连，与真残file
            # 不可分辨——退避 ~50ms 重试一次覆盖该间隙，仍拒连才按残file清理
            probe.close()
            time.sleep(0.05)
            probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            probe.settimeout(0.5)
            try:
                probe.connect(sock_path)
                alive = True
            except OSError:
                pass
        except OSError:
            pass
        if alive:
            log("已有活体 daemon 在位，本次拉起退出（exit 3）")
            probe.close()
            return 3
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
        # caller_pid 归因：id 是调用方进程内计数器，多 CLI 进程并发共号时完成行靠它指认发起者
        caller_pid = req.get("caller_pid")
        req_tag = f"请求 {req_id}" + (f"（来自 pid {caller_pid}）" if caller_pid is not None else "")
        model = engine_info["model"]
        import numpy as np  # 模块级缓存 import：零成本
        started = time.monotonic()
        try:
            text = req["text"]
            ref = req.get("ref_audio_path")
            if not ref:
                raise KeyError("ref_audio_path")
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
                send_frame(client, {"type": "error", "id": req_id, "message": "engine produced no audio"})
                return
            sample_rate, wav_data = result
            # wav_data = int16 (samples, channels) 转置形态（Gradio 约定）；单声道拍平后编码
            samples = np.asarray(wav_data).astype("<i2").reshape(-1)
            send_frame(client, {
                "type": "audio",
                "id": req_id,
                "pcm": base64.b64encode(samples.tobytes()).decode("ascii"),
                "sample_rate": int(sample_rate),
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

    def load_engine() -> None:
        try:
            engine_mod = load_engine_with_fastload(args_repo, log)

            # use_bf16 关闭沿用 per-call 既有裁决（MPS 强制 fp32，作者注 bf16 更慢）；
            # device 缺省走引擎自动检测（cuda→xpu→mps→cpu，M3 Max 落 mps）
            model = engine_mod.IndexTTS2(cfg_path=os.path.join(args.models, "config.yaml"), model_dir=args.models)
            engine_info["model"] = model
            engine_info["ready"] = {
                "type": "ready",
                "engine": "indextts",
                "version": "2.5",
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
    args_repo = os.path.abspath(args.repo)
    threading.Thread(target=accept_loop, daemon=True).start()
    threading.Thread(target=worker_loop, daemon=True).start()
    load_engine()  # 主线程加载：accept 已开闸，加载期连接排队等待，就绪即广播
    while not stop_flag.is_set():
        time.sleep(0.2)
    cleanup()
    return 1 if engine_info.get("fatal") else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="IndexTTS say shim")
    parser.add_argument("--repo", required=True, help="index-tts 仓库根（indextts 包以仓库形态在 sys.path 定位）")
    parser.add_argument("--models", default=None, help="checkpoints 目录（config.yaml 与权重落位根）；per-call/daemon 形态必带，print-fingerprint 不需要")
    parser.add_argument("--lab", default=None, help="say-lab 引擎目录（daemon 形态 sock/pid/log 与权重指纹落点）；缺省按 repo 父目录推导")
    parser.add_argument("--print-fingerprint", action="store_true", help="只打印权重指纹并退出（排障与公式对拍用，不触引擎 import）")
    parser.add_argument("--daemon", action="store_true", help="常驻服务形态：bind unix socket 经 JSONL 帧服务多 CLI 连接，闲置自收割")
    parser.add_argument("--idle-minutes", type=float, default=30.0, help="daemon 闲置收割阈值（分钟），无请求无连接超阈即自退（票 03：indextts 档 30）")
    args = parser.parse_args()

    if args.print_fingerprint:
        lab = os.path.abspath(args.lab) if args.lab else os.path.dirname(os.path.abspath(args.repo))
        print(weights_fingerprint(lab))
        return 0

    if args.daemon:
        if args.models is None:
            parser.error("--daemon 形态必须携带 --models（加载 config.yaml 与权重根）")
        return serve_daemon(args)

    if args.models is None:
        parser.error("per-call 形态必须携带 --models（checkpoints 目录）")

    # 协议通道先于引擎 import 固定：import 期就可能 print
    protocol = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
    sys.stdout = sys.stderr

    def emit(obj) -> None:
        protocol.write(json.dumps(obj, ensure_ascii=False) + "\n")
        protocol.flush()

    try:
        # 自报行进 stderr：协议通道是 dup 出的 fd1，sys.stdout 已整体改道，引擎 print 与
        # fastload 归因同流，不污染协议面
        engine_mod = load_engine_with_fastload(args.repo, lambda msg: print(msg, file=sys.stderr, flush=True))

        # use_bf16 关闭：调研实证 MPS 强制 fp32（作者注释 bf16 在 MPS 更慢）；
        # device 缺省走引擎自动检测（cuda→xpu→mps→cpu，M3 Max 落 mps）
        model = engine_mod.IndexTTS2(cfg_path=os.path.join(args.models, "config.yaml"), model_dir=args.models)
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
            # 协议 text_lang 即引擎 lang：Node 侧自判 zh/en/ja 下传（LANGUAGES 表 ja 一等），不依赖引擎侧检测
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
