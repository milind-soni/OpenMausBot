import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import av
import numpy as np

MAX_BYTES = 10 * 1024 * 1024
UPLOAD_TIMEOUT = 20
MAX_SECONDS = 120
SAMPLE_RATE = 16000
AUDIO_TYPES = {"audio/webm", "audio/ogg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/mpeg"}


class AudioError(Exception):
    def __init__(self, code, status=422):
        self.code = code
        self.status = status


def decode_bounded_audio(data):
    """Decode the HTTP audio payload to mono PCM without exceeding the duration budget."""
    samples = []
    count = 0
    try:
        with av.open(io.BytesIO(data)) as container:
            if not container.streams.audio:
                raise AudioError("invalid_audio")
            stream = container.streams.audio[0]
            stream.thread_type = "AUTO"
            resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
            for frame in container.decode(stream):
                for output in resampler.resample(frame):
                    count += output.samples
                    if count > SAMPLE_RATE * MAX_SECONDS:
                        raise AudioError("too_long", 413)
                    samples.append(output.to_ndarray().reshape(-1))
            for output in resampler.resample(None):
                count += output.samples
                if count > SAMPLE_RATE * MAX_SECONDS:
                    raise AudioError("too_long", 413)
                samples.append(output.to_ndarray().reshape(-1))
    except AudioError:
        raise
    except Exception:
        raise AudioError("invalid_audio") from None
    if not count:
        raise AudioError("no_speech")
    return np.concatenate(samples).astype(np.float32) / 32768.0


def handler_for(model):
    occupied = threading.BoundedSemaphore(1)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def reply(self, status, body):
            data = json.dumps(body, ensure_ascii=False).encode()
            try:
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def trusted_request(self):
            """Refuse browser callers and DNS rebinding before they can occupy inference."""
            expected_host = f"127.0.0.1:{self.server.server_port}"
            if (self.headers.get_all("Host") != [expected_host]
                    or self.headers.get("Origin") is not None
                    or any(self.headers.get(name) is not None for name in ("Sec-Fetch-Site", "Sec-Fetch-Dest", "Sec-Fetch-User"))):
                self.reply(403, {"error": {"code": "forbidden"}})
                return False
            return True

        def do_GET(self):
            if not self.trusted_request():
                return
            self.reply(200, {"ready": True}) if self.path == "/health" else self.reply(404, {"error": {"code": "not_found"}})

        def read_upload(self, size):
            deadline = time.monotonic() + UPLOAD_TIMEOUT
            data = bytearray()
            previous_timeout = self.connection.gettimeout()
            try:
                while len(data) < size:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise AudioError("upload_timeout", 408)
                    self.connection.settimeout(remaining)
                    try:
                        chunk = self.rfile.read1(min(size - len(data), 64 * 1024))
                    except TimeoutError:
                        raise AudioError("upload_timeout", 408) from None
                    if not chunk:
                        raise AudioError("invalid_audio", 400)
                    if time.monotonic() >= deadline:
                        raise AudioError("upload_timeout", 408)
                    data.extend(chunk)
            finally:
                self.connection.settimeout(previous_timeout)
            return data

        def do_POST(self):
            if not self.trusted_request():
                return
            if self.path != "/transcribe":
                return self.reply(404, {"error": {"code": "not_found"}})
            if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() not in AUDIO_TYPES:
                return self.reply(415, {"error": {"code": "invalid_audio"}})
            if not occupied.acquire(blocking=False):
                return self.reply(429, {"error": {"code": "busy"}})
            try:
                self.connection.settimeout(UPLOAD_TIMEOUT)
                try:
                    size = int(self.headers.get("Content-Length", "0"))
                except ValueError:
                    raise AudioError("invalid_audio", 400) from None
                if size <= 0:
                    raise AudioError("invalid_audio", 400)
                if size > MAX_BYTES:
                    raise AudioError("too_large", 413)
                data = self.read_upload(size)
                audio = decode_bounded_audio(data)
                del data
                language = self.headers.get("X-Dictation-Language", "").lower()
                segments, _info = model.transcribe(
                    audio, language=language or None, beam_size=3, vad_filter=True,
                    condition_on_previous_text=False,
                )
                text = " ".join(segment.text.strip() for segment in segments).strip()
                if not text:
                    raise AudioError("no_speech")
                self.reply(200, {"text": text})
            except AudioError as error:
                self.reply(error.status, {"error": {"code": error.code}})
            except Exception as error:
                print(f"transcription failed: {type(error).__name__}", file=sys.stderr, flush=True)
                self.reply(503, {"error": {"code": "unavailable"}})
            finally:
                occupied.release()

    return Handler


def main():
    from faster_whisper import WhisperModel

    model = WhisperModel(
        os.environ.get("OMB_STT_MODEL", "small"), device="cpu", compute_type="int8",
        cpu_threads=int(os.environ.get("OMB_STT_THREADS", "4")), num_workers=1,
        download_root=os.environ.get("OMB_STT_MODEL_DIR"),
        local_files_only=os.environ.get("OMB_STT_OFFLINE", "1") == "1",
    )
    server = ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("OMB_STT_PORT", "8810"))), handler_for(model))
    server.daemon_threads = True
    print("Local dictation worker ready.", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
