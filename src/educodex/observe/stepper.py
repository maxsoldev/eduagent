"""Step mode (educodex only): pause the loop at named points so you can inspect each step.

Breakpoints: beforeModelRequest, beforeToolCall, afterToolCall (the core's probe checkpoints).
Clients turn it on with debug/stepMode/set and resume with debug/continue.
"""

import asyncio

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

    def should_pause(self, name: str) -> bool:
        """True if the loop stops here. Also forgets earlier releases, so only a new debug/continue resumes."""
        if not (self.enabled and name in self.breakpoints):
            return False
        self._resume.clear()
        return True

    async def wait(self) -> None:
        """Until release(). An interrupt cancels the waiting turn, which also ends the wait."""
        await self._resume.wait()

    def release(self) -> None:
        self._resume.set()
