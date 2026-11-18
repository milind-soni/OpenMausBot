from __future__ import annotations

import os
import time
from typing import Any, Callable, Dict, Optional

import anyio
import httpx

from ._errors import ConflictError, JobFailedError, MausBotError, NotSentError, WaitTimeoutError
from ._http import Config, Expired, arequest, busy_thread, make_config, normalise, request
from ._types import Answer, ThreadState

WAIT_RAN_OUT = "Still working when the wait ran out. Call wait again with this thread."
STILL_BUSY = "The message was not sent: the thread was still busy when the wait ran out."
ON_APPROVAL = "The message was not sent: the thread is waiting for an approval in the app."


def _post_body(message: str, thread: Optional[str], wait: Optional[float]) -> Dict[str, Any]:
    body: Dict[str, Any] = {"message": message}
    if thread is not None:
        body["thread"] = thread
    if wait is not None:
        body["wait"] = wait
    return body


class Bot:
    """Talks to one bot's Bot API. Calls block."""

    def __init__(self, endpoint: Optional[str] = None, key: Optional[str] = None, *, base_url: Optional[str] = None,
                 bot_id: Optional[str] = None, max_retries: int = 2, retry_delay: float = 0.5,
                 http_client: Optional[httpx.Client] = None) -> None:
        self._config: Config = make_config(endpoint, key, base_url, bot_id, max_retries, retry_delay, dict(os.environ))
        self._owns_client = http_client is None
        self._client = http_client or httpx.Client()

    def __repr__(self) -> str:
        return f"Bot(base_url={self._config.base_url!r})"

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> "Bot":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def send(self, message: str, *, thread: Optional[str] = None, wait: Optional[float] = None) -> ThreadState:
        return normalise(request(self._client, self._config, "POST", body=_post_body(message, thread, wait)))

    def thread(self, thread_id: str) -> ThreadState:
        return normalise(request(self._client, self._config, "GET", {"thread": thread_id}))

    def wait(self, thread_id: str, *, timeout: float = 600, poll_interval: float = 2) -> Answer:
        return self._wait_until(thread_id, time.monotonic() + timeout, poll_interval,
                                lambda: WaitTimeoutError(WAIT_RAN_OUT, thread_id))

    def _wait_until(self, thread_id: str, deadline: float, poll_interval: float, expire: Callable[[], Exception]) -> Answer:
        """Reads the thread until it isn't working; `deadline` bounds the polls and each single read."""
        interval = poll_interval
        while True:
            try:
                state = normalise(request(self._client, self._config, "GET", {"thread": thread_id}, deadline=deadline))
            except Expired:
                raise expire() from None
            if state.status == "failed":
                raise JobFailedError(state.error, thread_id)
            if state.status != "working":
                return state
            left = deadline - time.monotonic()
            if left <= 0:
                raise expire()
            time.sleep(min(interval, left))
            interval = min(interval * 1.5, 10)

    def ask(self, message: str, *, thread: Optional[str] = None, wait: Optional[float] = None,
            timeout: float = 600, poll_interval: float = 2) -> Answer:
        deadline = time.monotonic() + timeout
        try:
            state = self.send(message, thread=thread, wait=wait)
        except ConflictError as error:
            busy = busy_thread(error)
            if busy is None:
                raise
            try:
                earlier = self._wait_until(busy, deadline, poll_interval, lambda: NotSentError(STILL_BUSY, busy))
                if earlier.status == "needs_approval":
                    raise NotSentError(ON_APPROVAL, busy)
            except JobFailedError:
                pass  # an earlier turn that failed leaves the thread free
            state = self.send(message, thread=thread, wait=wait)
        if state.status == "failed":
            raise JobFailedError(state.error, state.thread)
        if state.status != "working":
            return state
        return self._wait_until(state.thread, deadline, poll_interval, lambda: WaitTimeoutError(WAIT_RAN_OUT, state.thread))


class AsyncBot:
    """The same as `Bot`, with awaitable calls, on httpx.AsyncClient."""

    def __init__(self, endpoint: Optional[str] = None, key: Optional[str] = None, *, base_url: Optional[str] = None,
                 bot_id: Optional[str] = None, max_retries: int = 2, retry_delay: float = 0.5,
                 http_client: Optional[httpx.AsyncClient] = None) -> None:
        self._config: Config = make_config(endpoint, key, base_url, bot_id, max_retries, retry_delay, dict(os.environ))
        self._owns_client = http_client is None
        self._client = http_client or httpx.AsyncClient()

    def __repr__(self) -> str:
        return f"AsyncBot(base_url={self._config.base_url!r})"

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def __aenter__(self) -> "AsyncBot":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

    async def send(self, message: str, *, thread: Optional[str] = None, wait: Optional[float] = None) -> ThreadState:
        return normalise(await arequest(self._client, self._config, "POST", body=_post_body(message, thread, wait)))

    async def thread(self, thread_id: str) -> ThreadState:
        return normalise(await arequest(self._client, self._config, "GET", {"thread": thread_id}))

    async def wait(self, thread_id: str, *, timeout: float = 600, poll_interval: float = 2) -> Answer:
        return await self._wait_until(thread_id, time.monotonic() + timeout, poll_interval,
                                      lambda: WaitTimeoutError(WAIT_RAN_OUT, thread_id))

    async def _wait_until(self, thread_id: str, deadline: float, poll_interval: float, expire: Callable[[], Exception]) -> Answer:
        interval = poll_interval
        while True:
            try:
                state = normalise(await arequest(self._client, self._config, "GET", {"thread": thread_id}, deadline=deadline))
            except Expired:
                raise expire() from None
            if state.status == "failed":
                raise JobFailedError(state.error, thread_id)
            if state.status != "working":
                return state
            left = deadline - time.monotonic()
            if left <= 0:
                raise expire()
            await anyio.sleep(min(interval, left))
            interval = min(interval * 1.5, 10)

    async def ask(self, message: str, *, thread: Optional[str] = None, wait: Optional[float] = None,
                  timeout: float = 600, poll_interval: float = 2) -> Answer:
        deadline = time.monotonic() + timeout
        try:
            state = await self.send(message, thread=thread, wait=wait)
        except ConflictError as error:
            busy = busy_thread(error)
            if busy is None:
                raise
            try:
                earlier = await self._wait_until(busy, deadline, poll_interval, lambda: NotSentError(STILL_BUSY, busy))
                if earlier.status == "needs_approval":
                    raise NotSentError(ON_APPROVAL, busy)
            except JobFailedError:
                pass  # an earlier turn that failed leaves the thread free
            state = await self.send(message, thread=thread, wait=wait)
        if state.status == "failed":
            raise JobFailedError(state.error, state.thread)
        if state.status != "working":
            return state
        return await self._wait_until(state.thread, deadline, poll_interval, lambda: WaitTimeoutError(WAIT_RAN_OUT, state.thread))
