from __future__ import annotations

import json
import re
import time
from typing import Any, Dict, Optional, Tuple
from urllib.parse import quote, unquote, urlsplit

import anyio
import httpx

from ._errors import APIConnectionError, MausBotError, ServerError, error_for
from ._types import Failed, NeedsApproval, Replied, ThreadState, Working

NO_ADDRESS = "No bot address: pass `endpoint` (the address on the bot's Bot API card) or set MAUSBOT_BOT_URL."
NO_KEY = "No key: pass `key` or set MAUSBOT_BOT_KEY."
_CARD = re.compile(r"^(.*)/hooks/api/(?:v1/)?bots/([^/]+)/messages/?$")


class Expired(Exception):
    """A read bounded by a deadline ran out of time; the caller turns it into its own error."""


class Config:
    """Where and how to call. The key lives only here and is not shown by repr."""

    def __init__(self, base_url: str, bot_id: str, key: str, max_retries: int, retry_delay: float) -> None:
        self.base_url = base_url
        self.path = f"/hooks/api/v1/bots/{quote(bot_id, safe='')}/messages"
        self.max_retries = max_retries
        self.retry_delay = retry_delay
        self._key = key

    def __repr__(self) -> str:
        return f"Config(base_url={self.base_url!r})"

    @property
    def headers(self) -> Dict[str, str]:
        return {"authorization": f"Bearer {self._key}"}


def _origin(url: str) -> Optional[Tuple[str, str]]:
    """(origin, path) of an http(s) address, or None."""
    try:
        parts = urlsplit(url)
        host = parts.hostname
        port = f":{parts.port}" if parts.port else ""
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not host:
        return None
    host = f"[{host}]" if ":" in host else host
    return f"{parts.scheme}://{host}{port}", parts.path


def make_config(endpoint: Optional[str], key: Optional[str], base_url: Optional[str], bot_id: Optional[str],
                max_retries: int, retry_delay: float, env: Dict[str, str]) -> Config:
    key = (key if key is not None else env.get("MAUSBOT_BOT_KEY", "")).strip()
    if not key:
        raise MausBotError(NO_KEY)
    base = base_url.strip().rstrip("/") if base_url else ""
    if base and _origin(base) is None:
        raise MausBotError("`base_url` must be an http or https address.")
    if not base or not bot_id:
        found = _origin((endpoint if endpoint is not None else env.get("MAUSBOT_BOT_URL", "")).strip())
        match = _CARD.match(found[1]) if found else None
        if not found or not match:
            raise MausBotError(NO_ADDRESS)
        base = found[0] + match.group(1)
        try:
            bot_id = unquote(match.group(2), errors="strict")
        except UnicodeDecodeError:
            raise MausBotError(NO_ADDRESS) from None
    return Config(base, bot_id, key, max_retries, retry_delay)


def normalise(body: Any) -> ThreadState:
    b = body if isinstance(body, dict) else {}
    thread = b.get("thread")
    if not isinstance(thread, str):
        raise MausBotError("The server's answer has no thread id")
    if "status" not in b and isinstance(b.get("reply"), str):
        return Replied(b["reply"], thread)
    status = b.get("status")
    if status == "working":
        return Working(thread)
    if status == "needs_approval":
        return NeedsApproval(thread)
    if status == "failed":
        error = b.get("error")
        return Failed(thread, error if isinstance(error, str) else "The bot could not answer.")
    raise MausBotError(f"The server answered with an unknown status: {json.dumps(status)}")


def busy_thread(error: Any) -> Optional[str]:
    """The thread a 409 names when it says the thread is working, else None."""
    body = error.body
    if isinstance(body, dict) and body.get("status") == "working" and "error" not in body and isinstance(body.get("thread"), str):
        return body["thread"]
    return None


def request_kwargs(config: Config, method: str, query: Optional[Dict[str, str]], body: Any, deadline: Optional[float]) -> Dict[str, Any]:
    kwargs: Dict[str, Any] = {"method": method, "url": config.base_url + config.path, "headers": config.headers}
    if query:
        kwargs["params"] = query
    if method == "POST":
        kwargs["json"] = body
    if deadline is not None:
        kwargs["timeout"] = max(deadline - time.monotonic(), 0.001)
    return kwargs


def parse(config: Config, res: httpx.Response) -> Any:
    try:
        body = res.json()
    except ValueError:
        body = None
    if res.status_code >= 400:
        raise error_for(res.status_code, body, res.headers.get("retry-after"))
    return body


def unreachable(config: Config) -> APIConnectionError:
    # The cause can echo the request, so it is not chained.
    return APIConnectionError(f"Could not reach the MausBot server at {_origin(config.base_url)[0]}")  # type: ignore[index]


def retryable(method: str, error: Exception, attempt: int, config: Config) -> bool:
    return method == "GET" and isinstance(error, (APIConnectionError, ServerError)) and attempt < config.max_retries


def request(client: httpx.Client, config: Config, method: str, query: Optional[Dict[str, str]] = None,
            body: Any = None, deadline: Optional[float] = None) -> Any:
    """One call. A GET is retried on a network error or a 5xx; a POST never is, since a retry could start a second turn."""
    for attempt in range(config.max_retries + 1):
        try:
            try:
                res = client.request(**request_kwargs(config, method, query, body, deadline))
            except httpx.TimeoutException:
                if deadline is not None:
                    raise Expired() from None
                raise unreachable(config) from None
            except httpx.HTTPError:
                raise unreachable(config) from None
            return parse(config, res)
        except (APIConnectionError, ServerError) as error:
            if not retryable(method, error, attempt, config):
                raise
            time.sleep(config.retry_delay * 2 ** attempt)
    raise AssertionError("unreachable")


async def arequest(client: httpx.AsyncClient, config: Config, method: str, query: Optional[Dict[str, str]] = None,
                   body: Any = None, deadline: Optional[float] = None) -> Any:
    for attempt in range(config.max_retries + 1):
        try:
            try:
                res = await client.request(**request_kwargs(config, method, query, body, deadline))
            except httpx.TimeoutException:
                if deadline is not None:
                    raise Expired() from None
                raise unreachable(config) from None
            except httpx.HTTPError:
                raise unreachable(config) from None
            return parse(config, res)
        except (APIConnectionError, ServerError) as error:
            if not retryable(method, error, attempt, config):
                raise
            await anyio.sleep(config.retry_delay * 2 ** attempt)
    raise AssertionError("unreachable")
