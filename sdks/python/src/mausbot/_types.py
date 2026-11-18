from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Union


@dataclass(frozen=True)
class Replied:
    reply: str
    thread: str
    status: Literal["replied"] = "replied"


@dataclass(frozen=True)
class NeedsApproval:
    thread: str
    status: Literal["needs_approval"] = "needs_approval"


@dataclass(frozen=True)
class Working:
    thread: str
    status: Literal["working"] = "working"


@dataclass(frozen=True)
class Failed:
    thread: str
    error: str
    status: Literal["failed"] = "failed"


Answer = Union[Replied, NeedsApproval]
ThreadState = Union[Replied, NeedsApproval, Working, Failed]
