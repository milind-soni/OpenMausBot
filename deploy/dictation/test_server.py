import io
import json
import socket
import threading
import unittest
import urllib.error
import urllib.request
import wave
from contextlib import redirect_stderr
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import patch

import server


def wav(seconds=1):
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(server.SAMPLE_RATE)
        audio.writeframes(b"\x00\x00" * (server.SAMPLE_RATE * seconds))
    return output.getvalue()


class DictationTests(unittest.TestCase):
    def test_decode_and_duration_bounds(self):
        self.assertEqual(len(server.decode_bounded_audio(wav())), server.SAMPLE_RATE)
        with self.assertRaises(server.AudioError) as error:
            server.decode_bounded_audio(wav(server.MAX_SECONDS + 1))
        self.assertEqual((error.exception.code, error.exception.status), ("too_long", 413))
        with self.assertRaises(server.AudioError) as error:
            server.decode_bounded_audio(b"not an audio file")
        self.assertEqual(error.exception.code, "invalid_audio")

    def test_only_one_inference_and_no_internal_error_details(self):
        started = threading.Event()
        release = threading.Event()
        diagnostics = io.StringIO()

        def transcribe(_audio, **_options):
            started.set()
            if not release.wait(5):
                raise RuntimeError("fixture timed out")
            raise RuntimeError("private model path must not be returned")

        with redirect_stderr(diagnostics), self.worker(SimpleNamespace(transcribe=transcribe)) as base:
            first = []
            thread = threading.Thread(target=lambda: first.append(self.post(base, wav())))
            thread.start()
            try:
                self.assertTrue(started.wait(5))
                self.assertEqual(self.post(base, wav(), {"Origin": "https://untrusted.example"}), (403, {"error": {"code": "forbidden"}}))
                self.assertEqual(self.post(base, wav()), (429, {"error": {"code": "busy"}}))
            finally:
                release.set()
                thread.join(5)
            self.assertFalse(thread.is_alive())
            self.assertEqual(first, [(503, {"error": {"code": "unavailable"}})])
            self.assertEqual(self.post(base, wav()), (503, {"error": {"code": "unavailable"}}))
        self.assertEqual(diagnostics.getvalue(), "transcription failed: RuntimeError\n" * 2)

    def test_protocol_and_empty_speech(self):
        options = []

        def transcribe(_audio, **kwargs):
            options.append(kwargs)
            return iter([SimpleNamespace(text="  Review this.  ")]), None

        with self.worker(SimpleNamespace(transcribe=transcribe)) as base:
            with urllib.request.urlopen(base + "/health") as response:
                self.assertEqual(json.load(response), {"ready": True})
            self.assertEqual(self.post(base, wav()), (200, {"text": "Review this."}))
            self.assertEqual(self.post(base, wav(), {"Sec-Fetch-Mode": "cors"}), (200, {"text": "Review this."}))
            self.assertEqual(options[0]["language"], "pt")
            self.assertEqual(self.post(base, b"invalid"), (422, {"error": {"code": "invalid_audio"}}))
            self.assertEqual(self.post(base, b"x", {"Content-Length": str(server.MAX_BYTES + 1)}), (413, {"error": {"code": "too_large"}}))
        with self.worker(SimpleNamespace(transcribe=lambda *_args, **_kwargs: (iter([]), None))) as base:
            self.assertEqual(self.post(base, wav()), (422, {"error": {"code": "no_speech"}}))

    def test_rejects_browser_and_rebinding_requests_before_inference(self):
        calls = []

        def transcribe(_audio, **_options):
            calls.append(True)
            return iter([SimpleNamespace(text="Reviewed text.")]), None

        with self.worker(SimpleNamespace(transcribe=transcribe)) as base:
            for headers in [
                {"Origin": "https://untrusted.example"}, {"Origin": "null"}, {"Origin": ""},
                {"Host": "rebound.example"}, {"Host": "127.0.0.1"},
                {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-origin"},
                {"Sec-Fetch-Dest": "empty"},
            ]:
                with self.subTest(headers=headers):
                    self.assertEqual(self.post(base, wav(), headers), (403, {"error": {"code": "forbidden"}}))
                    request = urllib.request.Request(base + "/health", headers=headers)
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        urllib.request.urlopen(request, timeout=5)
                    self.assertEqual(error.exception.code, 403)
                    error.exception.close()
            self.assertEqual(calls, [])
            self.assertEqual(self.post(base, wav()), (200, {"text": "Reviewed text."}))
            self.assertEqual(calls, [True])

    def test_rejects_simple_browser_content_types_before_decoding(self):
        calls = []

        def transcribe(_audio, **_options):
            calls.append(True)
            return iter([SimpleNamespace(text="Reviewed text.")]), None

        with self.worker(SimpleNamespace(transcribe=transcribe)) as base:
            for media_type in ["text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data", ""]:
                with self.subTest(media_type=media_type):
                    self.assertEqual(self.post(base, wav(), {"Content-Type": media_type}), (415, {"error": {"code": "invalid_audio"}}))
            self.assertEqual(calls, [])
            self.assertEqual(self.post(base, wav(), {"Content-Type": "audio/wav; codecs=pcm"}), (200, {"text": "Reviewed text."}))

    def test_rejects_duplicate_host_headers(self):
        with self.worker(SimpleNamespace(transcribe=lambda *_args, **_kwargs: (iter([]), None))) as base:
            connection = HTTPConnection("127.0.0.1", int(base.rsplit(":", 1)[1]), timeout=5)
            try:
                connection.putrequest("GET", "/health", skip_host=True)
                connection.putheader("Host", base.removeprefix("http://"))
                connection.putheader("Host", "rebound.example")
                connection.endheaders()
                with connection.getresponse() as response:
                    self.assertEqual(response.status, 403)
            finally:
                connection.close()

    def test_rejects_trickling_upload_and_releases_slot(self):
        calls = []

        def transcribe(_audio, **_options):
            calls.append(True)
            return iter([SimpleNamespace(text="Reviewed text.")]), None

        with patch.object(server, "UPLOAD_TIMEOUT", 0.2, create=True), self.worker(SimpleNamespace(transcribe=transcribe)) as base:
            connection = HTTPConnection("127.0.0.1", int(base.rsplit(":", 1)[1]), timeout=3)
            stopped = threading.Event()
            sender = None
            try:
                connection.putrequest("POST", "/transcribe")
                connection.putheader("Content-Type", "audio/wav")
                connection.putheader("Content-Length", "12")
                connection.endheaders()
                stream = connection.sock

                def trickle():
                    for _ in range(12):
                        if stopped.is_set():
                            return
                        try:
                            stream.sendall(b"x")
                        except OSError:
                            return
                        if stopped.wait(0.05):
                            return

                sender = threading.Thread(target=trickle)
                sender.start()
                with connection.getresponse() as response:
                    stopped.set()
                    self.assertEqual((response.status, json.load(response)), (408, {"error": {"code": "upload_timeout"}}))
            finally:
                stopped.set()
                if sender:
                    sender.join(3)
                    self.assertFalse(sender.is_alive())
                connection.close()
            self.assertEqual(calls, [])
            self.assertEqual(self.post(base, wav()), (200, {"text": "Reviewed text."}))
            self.assertEqual(calls, [True])

    def test_rejects_incomplete_upload_and_releases_slot(self):
        calls = []

        def transcribe(_audio, **_options):
            calls.append(True)
            return iter([SimpleNamespace(text="Reviewed text.")]), None

        with self.worker(SimpleNamespace(transcribe=transcribe)) as base:
            connection = HTTPConnection("127.0.0.1", int(base.rsplit(":", 1)[1]), timeout=3)
            try:
                connection.putrequest("POST", "/transcribe")
                connection.putheader("Content-Type", "audio/wav")
                connection.putheader("Content-Length", "12")
                connection.endheaders(b"x")
                connection.sock.shutdown(socket.SHUT_WR)
                with connection.getresponse() as response:
                    self.assertEqual((response.status, json.load(response)), (400, {"error": {"code": "invalid_audio"}}))
            finally:
                connection.close()
            self.assertEqual(calls, [])
            self.assertEqual(self.post(base, wav()), (200, {"text": "Reviewed text."}))
            self.assertEqual(calls, [True])

    @staticmethod
    def post(base, audio, headers=None):
        request = urllib.request.Request(base + "/transcribe", data=audio, headers={"Content-Type": "audio/wav", "X-Dictation-Language": "pt", **(headers or {})})
        try:
            response = urllib.request.urlopen(request, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.code, json.load(response)

    class worker:
        def __init__(self, model):
            self.server = ThreadingHTTPServer(("127.0.0.1", 0), server.handler_for(model))
            self.thread = threading.Thread(target=self.server.serve_forever)

        def __enter__(self):
            self.thread.start()
            return "http://127.0.0.1:" + str(self.server.server_port)

        def __exit__(self, *_args):
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(5)


if __name__ == "__main__":
    unittest.main()
