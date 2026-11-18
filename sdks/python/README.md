# mausbot

Talk to a MausBot bot from your own code, through its Bot API. One dependency (`httpx`); Python 3.9+. Server-side only: the key reads whatever the bot can read; only an "Acts as me" key acts as the owner.

```sh
pip install mausbot
```

```python
import os
from mausbot import Bot

bot = Bot(
    os.environ["MAUSBOT_BOT_URL"],  # the address on the bot's Bot API card
    os.environ["MAUSBOT_BOT_KEY"],
)

answer = bot.ask("What's on my calendar tomorrow?")
# Replied(reply, thread) | NeedsApproval(thread)
bot.ask("Move the 3pm to Friday", thread=answer.thread)

sent = bot.send("Start the weekly report", wait=0)  # one POST, the server's answer as is
now = bot.thread(sent.thread)                       # one GET
done = bot.wait(sent.thread, timeout=600)           # keeps reading until it is not "working"
```

`AsyncBot` is the same with `await`, on `httpx.AsyncClient`; use it as `async with AsyncBot(...) as bot:`. Use `with Bot(...) as bot:` to close the connection pool.

Paste the card's address as it is. With no arguments, `Bot` reads `MAUSBOT_BOT_URL` and `MAUSBOT_BOT_KEY`. You can also pass `base_url` and `bot_id`.

`ask` returns `NeedsApproval` as a result: a person answers it in the app, and you can `wait` again later. If the thread is still busy, `ask` waits for it, then sends once; if that thread is waiting for an approval it raises `NotSentError` and sends nothing. `timeout` covers the waiting after the send; the send itself can take up to `wait` seconds (50 by default). `send` on a thread that is still working raises `ConflictError` (409), whose `body` is `{thread, status: "working"}` and whose message is `HTTP 409`.

## Errors

All errors extend `MausBotError`. HTTP errors extend `APIStatusError` (`status`, `body`, the server's `error` text as the message): `BadRequestError` (400, 413, 415), `AuthenticationError` (401), `PermissionDeniedError` (403), `NotFoundError` (404), `ConflictError` (409), `RateLimitError` (429, with `retry_after` in seconds when sent), `ServerError` (5xx), and `ServerTooOldError` (a subclass of `NotFoundError`: this MausBot server has no `/v1` address; update MausBot). The message is `HTTP <status>` when the body isn't JSON or has no string `error`. Others: `APIConnectionError` ("Could not reach…" means it never connected; on a `POST`, "dropped before it answered" means the message may have been sent), `WaitTimeoutError`, `JobFailedError` and `NotSentError`, each carrying the `thread` id where there is one. The key is never put in an error or a `repr`.

## Retries

Only `GET`, on a network error or a 5xx: `max_retries` times (default 2), waiting `retry_delay` seconds (default 0.5) and doubling. A `POST` is never retried, since that could start a second turn. `wait` and `ask` give up after `timeout` seconds (default 600) and poll every `poll_interval` seconds (default 2, growing to 10).

## Development

```sh
python -m venv .venv && .venv/bin/pip install -U pip   # pip 21.3+ is needed for `-e` with pyproject.toml
.venv/bin/pip install -e ".[dev]" && .venv/bin/pytest -q
```
