from __future__ import annotations

import socket
import time

import httpx
import pytest

from mausbot import AsyncBot, AuthenticationError, Bot, MausBotError, WaitTimeoutError

SECRET = "k_secret_123"
CARD = "https://x.example/hooks/api/bots/b1/messages"


def recorder(status=200, body=None):
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append({"url": str(request.url), "auth": request.headers.get("authorization")})
        return httpx.Response(status, json=body or {"reply": "hi", "thread": "t1"})

    return calls, httpx.Client(transport=httpx.MockTransport(handler))


def test_rewrites_the_cards_address_to_v1_including_local_and_trailing_slash():
    calls, client = recorder()
    with client:
        Bot("http://127.0.0.1:8799/hooks/api/bots/b1/messages/", "k", http_client=client).send("x")
    assert calls[0]["url"] == "http://127.0.0.1:8799/hooks/api/v1/bots/b1/messages"


def test_keeps_an_address_that_already_has_v1():
    calls, client = recorder()
    with client:
        Bot("https://x.example/hooks/api/v1/bots/b1/messages", "k", http_client=client).send("x")
    assert calls[0]["url"] == "https://x.example/hooks/api/v1/bots/b1/messages"


def test_reads_env_trimmed(monkeypatch):
    monkeypatch.setenv("MAUSBOT_BOT_URL", " https://x.example/hooks/api/bots/b1/messages\n")
    monkeypatch.setenv("MAUSBOT_BOT_KEY", "k_test\n")
    calls, client = recorder()
    with client:
        Bot(http_client=client).send("x")
    assert calls[0] == {"url": "https://x.example/hooks/api/v1/bots/b1/messages", "auth": "Bearer k_test"}


def test_refuses_a_missing_key_or_a_bad_address_at_construction(monkeypatch):
    monkeypatch.setenv("MAUSBOT_BOT_KEY", "")
    with pytest.raises(MausBotError):
        Bot(CARD)
    monkeypatch.delenv("MAUSBOT_BOT_URL", raising=False)
    for endpoint in ("https://x.example/other", "not a url", None, "ftp://x.example/hooks/api/bots/b1/messages",
                     "https://x.example/hooks/api/bots/%ff/messages",
                     "https://x.example/hooks/api/bots/%zz/messages", "https://x.example/hooks/api/bots/%E/messages"):
        with pytest.raises(MausBotError) as info:
            Bot(endpoint, SECRET)
        assert SECRET not in str(info.value) and SECRET not in repr(info.value)


@pytest.mark.parametrize("key", ["k_secret_\u00e9", "k_secret_\u200b", "k_sec\nret"])
def test_refuses_a_key_with_characters_a_key_never_has(key):
    with pytest.raises(MausBotError) as info:
        Bot(CARD, key)
    assert key not in str(info.value) and key not in repr(info.value)


def test_refuses_a_bad_base_url_at_construction():
    for base_url in ("nope", "ftp://x.example", "http://"):
        with pytest.raises(MausBotError):
            Bot(base_url=base_url, bot_id="b1", key="k")


def test_a_bad_percent_escape_in_the_address_is_a_mausbot_error():
    with pytest.raises(MausBotError):
        Bot("https://x.example/hooks/api/bots/%E9/messages", "k")


def test_never_puts_the_key_in_an_error_or_a_repr():
    _, client = recorder(401, {"error": "Invalid key"})
    bot = Bot(CARD, SECRET, http_client=client)
    with client, pytest.raises(AuthenticationError) as info:
        bot.send("x")
    assert SECRET not in str(info.value) and SECRET not in repr(info.value)
    assert SECRET not in repr(bot) and SECRET not in repr(vars(bot))
    assert SECRET not in repr(AsyncBot(CARD, SECRET))


def test_wait_on_a_server_that_never_answers_stops_at_the_timeout():
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(5)
    try:
        with Bot(base_url=f"http://127.0.0.1:{listener.getsockname()[1]}", bot_id="b1", key="k") as bot:
            started = time.monotonic()
            with pytest.raises(WaitTimeoutError):
                bot.wait("t1", timeout=0.2)
            assert time.monotonic() - started < 1
    finally:
        listener.close()


@pytest.mark.parametrize("bad", [dict(max_retries=-1), dict(max_retries=1.5), dict(max_retries=True), dict(retry_delay=-1), dict(retry_delay="1")])
def test_refuses_bad_retry_settings_at_construction(bad):
    with pytest.raises(MausBotError):
        Bot(CARD, "k", **bad)


@pytest.mark.parametrize("endpoint", ["https://x.example/hooks/api/bots/a.b/messages", "https://x.example/hooks/api/bots/%20/messages"])
def test_refuses_a_bot_id_outside_the_allowed_characters(endpoint):
    with pytest.raises(MausBotError):
        Bot(endpoint, "k")
    with pytest.raises(MausBotError):
        Bot(base_url="https://x.example", bot_id="a" * 129, key="k")


def test_a_post_that_dropped_after_connecting_may_have_been_sent_but_a_refused_connection_was_not():
    def drop(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadError("boom", request=request)

    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom", request=request)

    with Bot(CARD, "k", http_client=httpx.Client(transport=httpx.MockTransport(drop))) as bot, pytest.raises(MausBotError, match="may have been sent"):
        bot.send("x")
    with Bot(CARD, "k", http_client=httpx.Client(transport=httpx.MockTransport(refuse))) as bot, pytest.raises(MausBotError, match="Could not reach"):
        bot.send("x")


def _slow_server(delay):
    import json
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Handler(BaseHTTPRequestHandler):
        timeout = 2

        def log_message(self, *args):
            pass

        def do_POST(self):
            self.rfile.read(int(self.headers.get("content-length") or 0))
            time.sleep(delay)
            data = json.dumps({"reply": "hi", "thread": "t1"}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def test_a_callers_own_short_timeout_does_not_cut_a_post_short():
    server = _slow_server(1)
    try:
        url = f"http://127.0.0.1:{server.server_address[1]}"
        with httpx.Client(timeout=0.5) as client:
            bot = Bot(base_url=url, bot_id="b1", key="k", http_client=client)
            assert bot.send("x").reply == "hi"
            assert bot.ask("x").reply == "hi"
    finally:
        server.shutdown()
        server.server_close()


@pytest.mark.anyio
async def test_a_callers_own_short_timeout_does_not_cut_an_async_post_short():
    server = _slow_server(1)
    try:
        url = f"http://127.0.0.1:{server.server_address[1]}"
        async with httpx.AsyncClient(timeout=0.5) as client:
            bot = AsyncBot(base_url=url, bot_id="b1", key="k", http_client=client)
            assert (await bot.send("x")).reply == "hi"
            assert (await bot.ask("x")).reply == "hi"
    finally:
        server.shutdown()
        server.server_close()
