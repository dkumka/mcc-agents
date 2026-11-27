#!/usr/bin/env python3
"""
Local speech-to-text HTTP service for MCC Agents (GigaAM-v4 RNN-T, ONNX int8 + GigaAM VAD).

Architecture:
- Lightweight stdlib HTTP supervisor (~25 MiB RAM in idle, no torch/onnxruntime imported here).
- Spawns a single worker subprocess lazily on the first /transcribe request.
- Worker holds the ONNX int8 model warm for MCC_VOICE_IDLE_SEC (default 900s = 15 min),
  then terminates cleanly so 100% of model RAM is returned to the OS.
- Strict concurrency = 1 with bounded waiting queue + MemAvailable / loadavg overload guard.
"""

from __future__ import annotations

import argparse
import json
import os
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

MODEL_ID = "local/gigaam-v4"
DEFAULT_HOST = os.environ.get("MCC_VOICE_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("MCC_VOICE_PORT", "3119"))
DATA_DIR = Path(os.environ.get("MCC_VOICE_DIR", "/home/klemid/.local/share/mcc-voice-local"))
MODEL_DIR = DATA_DIR / "models" / "gigaam-v4-onnx-int8"
FFMPEG_BIN = os.environ.get("MCC_VOICE_FFMPEG") or str(DATA_DIR / "bin" / "ffmpeg")
NUM_THREADS = int(os.environ.get("MCC_VOICE_THREADS", "4"))
IDLE_UNLOAD_SEC = int(os.environ.get("MCC_VOICE_IDLE_SEC", "900"))
MAX_QUEUE = int(os.environ.get("MCC_VOICE_MAX_QUEUE", "3"))
MAX_AUDIO_BYTES = int(os.environ.get("MCC_VOICE_MAX_BYTES", str(20 * 1024 * 1024)))
MIN_MEM_AVAIL_MB = int(os.environ.get("MCC_VOICE_MIN_MEM_MB", "1400"))
MAX_LOAD1 = float(os.environ.get("MCC_VOICE_MAX_LOAD1", "6.5"))
WORKER_TIMEOUT_SEC = int(os.environ.get("MCC_VOICE_TIMEOUT_SEC", "85"))


def read_mem_avail_mb() -> int:
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) // 1024
    except Exception:
        pass
    return -1


def read_load1() -> float:
    try:
        return round(os.getloadavg()[0], 2)
    except Exception:
        return -1.0


def ext_from_content_type(ct: str) -> str:
    t = (ct or "").lower()
    if "wav" in t:
        return "wav"
    if "webm" in t:
        return "webm"
    if "mp4" in t or "m4a" in t or "aac" in t:
        return "m4a"
    if "ogg" in t or "opus" in t:
        return "ogg"
    if "mpeg" in t or "mp3" in t:
        return "mp3"
    if "flac" in t:
        return "flac"
    return "bin"


def is_16k_mono_pcm_wav(path: str) -> bool:
    try:
        with wave.open(path, "rb") as w:
            return w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2
    except Exception:
        return False


def ensure_wav_16k(src_path: str, dst_path: str) -> str:
    if src_path.endswith(".wav") and is_16k_mono_pcm_wav(src_path):
        return src_path
    ffmpeg = FFMPEG_BIN if os.path.isfile(FFMPEG_BIN) else (shutil.which("ffmpeg") or "ffmpeg")
    proc = subprocess.run(
        [
            ffmpeg,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            src_path,
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            dst_path,
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg decode failed: {(proc.stderr or '').strip()[:300]}")
    return dst_path


# ------------------------------------------------------------------ worker mode


def run_worker() -> None:
    """Persistent child process: loads GigaAM-v4 ONNX int8 once, serves NDJSON commands on stdin/stdout."""
    os.environ["OMP_NUM_THREADS"] = str(NUM_THREADS)
    os.environ["MKL_NUM_THREADS"] = str(NUM_THREADS)
    os.environ["OPENBLAS_NUM_THREADS"] = str(NUM_THREADS)
    os.environ["HF_HUB_OFFLINE"] = "1"
    bin_dir = str(DATA_DIR / "bin")
    if os.path.isdir(bin_dir):
        os.environ["PATH"] = f"{bin_dir}:{os.environ.get('PATH', '')}"

    import importlib.util
    import torch

    torch.set_num_threads(NUM_THREADS)

    mod_path = MODEL_DIR / "modeling_gigaam.py"
    spec = importlib.util.spec_from_file_location("modeling_gigaam_local", str(mod_path))
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {mod_path}")
    mg = importlib.util.module_from_spec(spec)
    sys.modules["modeling_gigaam_local"] = mg
    spec.loader.exec_module(mg)

    t0 = time.perf_counter()
    sessions, cfg = mg.load_onnx(str(MODEL_DIR), "rnnt", provider="CPUExecutionProvider", num_threads=NUM_THREADS)
    vad = mg._load_vad_from_assets(
        MODEL_DIR / "vad.safetensors",
        MODEL_DIR / "vad_config.json",
        torch.device("cpu"),
    )
    load_ms = round((time.perf_counter() - t0) * 1000)

    def emit(obj: dict[str, Any]) -> None:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    emit({"ready": True, "loadMs": load_ms, "model": MODEL_ID})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            if req.get("cmd") == "quit":
                emit({"ok": True})
                break
            wav_path = str(req["wav"])
            with wave.open(wav_path, "rb") as w:
                dur = w.getnframes() / float(w.getframerate())
            ts = time.perf_counter()
            if dur <= 24.0:
                out = mg.infer_onnx(wav_path, cfg, sessions, batch_size=1, progress=False)
                text = out["e2e"][0].strip() if isinstance(out, dict) else str(out[0]).strip()
            else:
                segs, _ = mg._segment_audio_file(
                    wav_path,
                    16000,
                    merge_gap=0.7,
                    pad=0.2,
                    strict_limit_duration=25.0,
                    device=torch.device("cpu"),
                    vad=vad,
                )
                if not segs:
                    text = ""
                else:
                    out = mg.infer_onnx(segs, cfg, sessions, batch_size=2, progress=False)
                    parts = out["e2e"] if isinstance(out, dict) else out
                    text = " ".join(p.strip() for p in parts if p and p.strip()).strip()
            ms = round((time.perf_counter() - ts) * 1000)
            emit({"ok": True, "text": text, "ms": ms, "durationSec": round(dur, 2)})
        except Exception as exc:
            emit({"ok": False, "error": str(exc)})


# ------------------------------------------------------------------ supervisor


class WorkerManager:
    def __init__(self) -> None:
        self._state_lock = threading.Lock()
        self._exec_lock = threading.Lock()
        self._proc: subprocess.Popen[str] | None = None
        self._last_used: float = 0.0
        self._busy = False
        self._queued = 0
        self._stop_event = threading.Event()
        self._reaper = threading.Thread(target=self._reap_loop, daemon=True)
        self._reaper.start()

    def _is_alive_locked(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def status(self) -> dict[str, Any]:
        with self._state_lock:
            loaded = self._is_alive_locked()
            busy = self._busy
            queued = self._queued
        return {
            "ok": True,
            "model": MODEL_ID,
            "loaded": loaded,
            "busy": busy,
            "queued": queued,
            "threads": NUM_THREADS,
            "idleUnloadSec": IDLE_UNLOAD_SEC,
            "memAvailMB": read_mem_avail_mb(),
            "load1": read_load1(),
        }

    def _kill_worker_locked(self) -> None:
        p = self._proc
        self._proc = None
        if p is None:
            return
        try:
            if p.poll() is None:
                try:
                    if p.stdin:
                        p.stdin.write(json.dumps({"cmd": "quit"}) + "\n")
                        p.stdin.flush()
                    p.wait(timeout=3)
                except Exception:
                    p.terminate()
                    try:
                        p.wait(timeout=3)
                    except Exception:
                        p.kill()
        finally:
            for stream in (p.stdin, p.stdout, p.stderr):
                try:
                    if stream:
                        stream.close()
                except Exception:
                    pass

    def _reap_loop(self) -> None:
        while not self._stop_event.wait(15.0):
            if IDLE_UNLOAD_SEC <= 0:
                continue
            with self._state_lock:
                should_unload = (
                    self._is_alive_locked()
                    and not self._busy
                    and self._queued == 0
                    and (time.monotonic() - self._last_used) >= IDLE_UNLOAD_SEC
                )
            if should_unload and self._exec_lock.acquire(blocking=False):
                try:
                    with self._state_lock:
                        if (
                            self._is_alive_locked()
                            and not self._busy
                            and self._queued == 0
                            and (time.monotonic() - self._last_used) >= IDLE_UNLOAD_SEC
                        ):
                            print("[voice-local] idle timeout reached — unloading worker", flush=True)
                            self._kill_worker_locked()
                finally:
                    self._exec_lock.release()

    def _read_line_timeout(self, proc: subprocess.Popen[str], timeout_sec: float) -> str:
        assert proc.stdout is not None
        fd = proc.stdout.fileno()
        rlist, _, _ = select.select([fd], [], [], timeout_sec)
        if not rlist:
            raise TimeoutError(f"Таймаут локального распознавания ({int(timeout_sec)} с)")
        line = proc.stdout.readline()
        if not line:
            err = ""
            try:
                if proc.stderr:
                    err = proc.stderr.read().strip()[-300:]
            except Exception:
                pass
            raise RuntimeError(f"Воркер завершился неожиданно{': ' + err if err else ''}")
        return line

    def _ensure_worker(self) -> subprocess.Popen[str]:
        with self._state_lock:
            if self._is_alive_locked():
                return self._proc  # type: ignore[return-value]
            self._kill_worker_locked()

        mem_mb = read_mem_avail_mb()
        if 0 <= mem_mb < MIN_MEM_AVAIL_MB:
            raise OverflowError(f"Недостаточно свободной памяти на сервере ({mem_mb} МБ, нужно ≥ {MIN_MEM_AVAIL_MB} МБ)")

        proc = subprocess.Popen(
            [sys.executable, os.path.abspath(__file__), "--worker"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        try:
            line = self._read_line_timeout(proc, 45.0)
            msg = json.loads(line)
            if not msg.get("ready"):
                raise RuntimeError(f"Worker startup error: {msg}")
            print(f"[voice-local] worker ready (model load {msg.get('loadMs')} ms)", flush=True)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
            raise

        with self._state_lock:
            self._proc = proc
            self._last_used = time.monotonic()
        return proc

    def transcribe(self, audio_bytes: bytes, content_type: str) -> dict[str, Any]:
        load1 = read_load1()
        if load1 > MAX_LOAD1:
            raise OverflowError(f"Сервер сейчас перегружен (load={load1:.1f}) — попробуйте позже")

        with self._state_lock:
            if self._queued >= MAX_QUEUE:
                raise OverflowError("Очередь распознавания переполнена — попробуйте через пару секунд")
            self._queued += 1

        ext = ext_from_content_type(content_type)
        tmp_dir = tempfile.mkdtemp(prefix="mcc-voice-")
        src_path = os.path.join(tmp_dir, f"in.{ext}")
        wav_path = os.path.join(tmp_dir, "out.wav")
        dequeued = False
        try:
            with open(src_path, "wb") as f:
                f.write(audio_bytes)
            ready_wav = ensure_wav_16k(src_path, wav_path)

            with self._exec_lock:
                with self._state_lock:
                    self._queued -= 1
                    dequeued = True
                    self._busy = True
                try:
                    proc = self._ensure_worker()
                    assert proc.stdin is not None
                    proc.stdin.write(json.dumps({"wav": ready_wav}) + "\n")
                    proc.stdin.flush()
                    resp_line = self._read_line_timeout(proc, float(WORKER_TIMEOUT_SEC))
                    resp = json.loads(resp_line)
                    with self._state_lock:
                        self._last_used = time.monotonic()
                    if not resp.get("ok"):
                        raise RuntimeError(resp.get("error") or "Ошибка распознавания")
                    return resp
                except (TimeoutError, RuntimeError, BrokenPipeError, OSError):
                    with self._state_lock:
                        self._kill_worker_locked()
                    raise
                finally:
                    with self._state_lock:
                        self._busy = False
        finally:
            if not dequeued:
                with self._state_lock:
                    self._queued = max(0, self._queued - 1)
            shutil.rmtree(tmp_dir, ignore_errors=True)

    def shutdown(self) -> None:
        self._stop_event.set()
        with self._state_lock:
            self._kill_worker_locked()


def make_handler(manager: WorkerManager):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: Any) -> None:
            print(f"[voice-local] {self.address_string()} {fmt % args}", flush=True)

        def _send_json(self, status: int, body: dict[str, Any]) -> None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            if self.path.split("?", 1)[0] == "/health":
                self._send_json(200, manager.status())
                return
            self._send_json(404, {"error": "not found"})

        def do_POST(self) -> None:
            if self.path.split("?", 1)[0] != "/transcribe":
                self._send_json(404, {"error": "not found"})
                return
            try:
                cl = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                cl = 0
            if cl <= 0:
                self._send_json(400, {"error": "Пустая запись"})
                return
            if cl > MAX_AUDIO_BYTES:
                self._send_json(413, {"error": "Запись слишком длинная"})
                return
            audio = self.rfile.read(cl)
            if len(audio) < 1000:
                self._send_json(400, {"error": "Пустая запись"})
                return
            ct = self.headers.get("Content-Type", "audio/webm")
            try:
                res = manager.transcribe(audio, ct)
                self._send_json(200, {
                    "text": res["text"],
                    "model": MODEL_ID,
                    "ms": res.get("ms"),
                    "durationSec": res.get("durationSec"),
                })
            except OverflowError as exc:
                self._send_json(503, {"error": str(exc)})
            except TimeoutError as exc:
                self._send_json(504, {"error": str(exc)})
            except Exception as exc:
                self._send_json(500, {"error": str(exc)})

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args()

    if args.worker:
        run_worker()
        return

    if not (MODEL_DIR / "rnnt_encoder.onnx").is_file():
        print(f"[voice-local] ERROR: model not found at {MODEL_DIR}", file=sys.stderr)
        sys.exit(1)

    manager = WorkerManager()
    server = ThreadingHTTPServer((args.host, args.port), make_handler(manager))

    def handle_sig(signum: int, _frame: Any) -> None:
        print(f"[voice-local] signal {signum}, shutting down", flush=True)
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, handle_sig)
    signal.signal(signal.SIGINT, handle_sig)

    print(
        f"[voice-local] listening on http://{args.host}:{args.port} "
        f"(model={MODEL_ID}, threads={NUM_THREADS}, idleUnload={IDLE_UNLOAD_SEC}s)",
        flush=True,
    )
    try:
        server.serve_forever()
    finally:
        manager.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
