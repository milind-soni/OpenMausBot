from __future__ import annotations

import re
from typing import Any, Dict, Optional, Type

TOO_OLD = (
    "This MausBot server is too old for this SDK: it has no /v1 Bot API address. "
    "Update MausBot on the computer that runs this bot."
)


class MausBotError(Exception):
    """Base class for every error this package raises."""


class APIStatusError(MausBotError):
    def __init__(self, message: str, status: int, body: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


class BadRequestError(APIStatusError): ...
class AuthenticationError(APIStatusError): ...
class PermissionDeniedError(APIStatusError): ...
class NotFoundError(APIStatusError): ...
class ConflictError(APIStatusError): ...
class ServerError(APIStatusError): ...


class RateLimitError(APIStatusError):
    def __init__(self, message: str, status: int, body: Any = None, retry_after: Optional[int] = None) -> None:
        super().__init__(message, status, body)
        self.retry_after = retry_after


class ServerTooOldError(NotFoundError):
    def __init__(self, status: int, body: Any = None) -> None:
        super().__init__(TOO_OLD, status, body)


class APIConnectionError(MausBotError): ...


class _ThreadError(MausBotError):
    def __init__(self, message: str, thread: str) -> None:
        super().__init__(message)
        self.thread = thread


class WaitTimeoutError(_ThreadError): ...
class JobFailedError(_ThreadError): ...
class NotSentError(_ThreadError): ...


_BY_STATUS: Dict[int, Type[APIStatusError]] = {
    400: BadRequestError, 413: BadRequestError, 415: BadRequestError, 401: AuthenticationError,
    403: PermissionDeniedError, 404: NotFoundError, 409: ConflictError,
}


def error_for(status: int, body: Any, retry_after_header: Optional[str]) -> APIStatusError:
    text = body.get("error") if isinstance(body, dict) else None
    message = text if isinstance(text, str) else f"HTTP {status}"
    if status == 404 and text == "Unknown webhook endpoint":
        return ServerTooOldError(status, body)
    if status == 429:
        after = retry_after_header.strip() if retry_after_header is not None else ""
        return RateLimitError(message, status, body, int(after) if re.fullmatch(r"[0-9]+", after) else None)
    if status >= 500:
        return ServerError(message, status, body)
    return _BY_STATUS.get(status, APIStatusError)(message, status, body)
