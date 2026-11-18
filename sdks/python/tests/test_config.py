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
