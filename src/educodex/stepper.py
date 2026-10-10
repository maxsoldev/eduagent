"""Step mode (educodex only): pause the loop at named points so you can inspect each step.

Breakpoints: beforeModelRequest, beforeToolCall, afterToolCall.
Clients turn it on with debug/stepMode/set and resume with debug/continue.
"""

import asyncio
from typing import Any

BREAKPOINTS = ("beforeModelRequest", "beforeToolCall", "afterToolCall")


class Stepper:
    def __init__(self) -> None:
        self.enabled = False
        self.breakpoints: set[str] = set(BREAKPOINTS)
        self._resume = asyncio.Event()

    def configure(self, enabled: bool, breakpoints: list[str] | None = None) -> None:
        self.enabled = enabled
        if breakpoints is not None:
            self.breakpoints = set(breakpoints) & set(BREAKPOINTS)
        if not enabled:
            self.release()

    async def pause(self, ctx: Any, name: str, info: dict[str, Any]) -> None:
        if not (self.enabled and name in self.breakpoints):
            return
        self._resume.clear()
        await ctx.trace("trace/paused", breakpoint=name, info=info)
        await self._resume.wait()
        await ctx.trace("trace/resumed", breakpoint=name)

    def release(self) -> None:
        self._resume.set()
