"""Events the core emits while it works.

Mirrors the idea of codex-rs/protocol/src/protocol.rs `EventMsg`: the core never talks to a UI
directly. It publishes events; the app server (or the CLI) turns them into JSON-RPC notifications
or terminal output.

Two families:
  * protocol events  -> same names as Codex app-server v2 notifications (e.g. "item/started")
  * trace events     -> educodex-only (trace/*), showing steps production harnesses hide; the core
                        never emits them itself, educodex.observe.Tracer does (see probe.py)
"""

import asyncio
import itertools
import sys
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

Listener = Callable[["Event"], Awaitable[None] | None]
_seq = itertools.count(1)


@dataclass
class Event:
    method: str  # e.g. "item/completed" or trace/modelRequest
    params: dict[str, Any]
    seq: int = field(default_factory=lambda: next(_seq))
    ts: float = field(default_factory=time.time)


class EventBus:
    """Fan-out of events to listeners (the app server, the CLI printer, tests)."""

    def __init__(self) -> None:
        self._listeners: list[Listener] = []

    def subscribe(self, listener: Listener) -> Callable[[], None]:
        self._listeners.append(listener)
        return lambda: self._listeners.remove(listener)

    async def emit(self, method: str, **params: Any) -> Event:
        event = Event(method, params)
        for listener in list(self._listeners):
            try:
                result = listener(event)
                if asyncio.iscoroutine(result):
                    await result
            except Exception as err:  # a broken observer must never break the agent loop
                print(f"educodex: event listener failed on {method}: {err!r}", file=sys.stderr)
        return event
