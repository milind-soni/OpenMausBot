from __future__ import annotations

import dataclasses
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

import pytest

import mausbot

CONTRACT = json.loads((Path(__file__).parents[2] / "contract" / "cases.json").read_text("utf8"))
CASES = CONTRACT["cases"]
FIELDS = ("status", "thread", "retryAfter", "message")


def snake(name: str) -> str:
    return re.sub(r"[A-Z]", lambda m: "_" + m.group(0).lower(), name)


class Stub:
    """Serves one case's exchanges in order and records what didn't match."""

    def __init__(self, case):
        self.queue = list(case["exchanges"])
        self.problems = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            timeout = 2  # a handler waiting for a request line that never comes would hang server_close()

            def log_message(self, *args):
                pass

            def _handle(self):
                url = urlsplit(self.path)
                raw = self.rfile.read(int(self.headers.get("content-length") or 0)).decode("utf8")
                if not stub.queue:
                    stub.problems.append(f"unexpected {self.command} {self.path}")
                    self.send_response(500)
                    self.send_header("content-length", "0")
                    self.end_headers()
                    return
                nxt = stub.queue[0]
                if not nxt.get("repeat"):
                    stub.queue.pop(0)
                want = nxt["request"]
                if self.command != want["method"]:
                    stub.problems.append(f"method {self.command} != {want['method']}")
                if url.path != f"/hooks/api/v1/bots/{CONTRACT['bot']}/messages":
                    stub.problems.append(f"path {url.path}")
                if self.headers.get("authorization") != f"Bearer {CONTRACT['key']}":
                    stub.problems.append("bad authorization")
                if want["method"] == "POST":
                    if json.loads(raw) != want["body"]:
                        stub.problems.append(f"body {raw}")
                elif dict(parse_qsl(url.query)) != want.get("query", {}):
                    stub.problems.append(f"query {url.query}")
                r = nxt["response"]
                if r.get("drop"):
                    self.close_connection = True
                    return
                if "rawBody" in r:
                    data, ctype = r["rawBody"].encode("utf8"), r["contentType"]
                else:
                    data, ctype = json.dumps(r["body"]).encode("utf8"), "application/json"
                self.send_response(r["status"])
                self.send_header("content-type", ctype)
                for k, v in r.get("headers", {}).items():
                    self.send_header(k, v)
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = _handle

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = False  # server_close() then joins the handler threads
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


def check(case, stub, outcome, error):
    if "error" in case:
        want = case["error"]
        assert error is not None, f"expected {want['type']}, got {outcome!r}"
        assert isinstance(error, getattr(mausbot, want["type"]))
        for field in FIELDS:
            if field not in want:
                continue
            got = getattr(error, snake(field), None) if field != "message" else str(error)
            assert got == want[field], field
        if "messageContains" in want:
            assert want["messageContains"] in str(error)
    else:
        assert error is None, repr(error)
        assert dataclasses.asdict(outcome) == case["result"]
    assert stub.problems == []
    assert [e for e in stub.queue if not e.get("repeat")] == []


def build(case, stub, cls, **extra):
    return cls(base_url=stub.url, bot_id=CONTRACT["bot"], key=CONTRACT["key"], retry_delay=0, **extra)


def arguments(call):
    options = {snake(k): v for k, v in call["options"].items()}
    method = call["method"]
    if method in ("send", "ask"):
        return (call["message"],), options
    return (call["thread"],), options


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_bot(case):
    with Stub(case) as stub, build(case, stub, mausbot.Bot) as bot:
        args, options = arguments(case["call"])
        outcome = error = None
        try:
            outcome = getattr(bot, case["call"]["method"])(*args, **options)
        except Exception as e:
            error = e
        check(case, stub, outcome, error)


@pytest.mark.anyio
@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
async def test_async_bot(case):
    with Stub(case) as stub:
        async with build(case, stub, mausbot.AsyncBot) as bot:
            args, options = arguments(case["call"])
            outcome = error = None
            try:
                outcome = await getattr(bot, case["call"]["method"])(*args, **options)
            except Exception as e:
                error = e
        check(case, stub, outcome, error)
