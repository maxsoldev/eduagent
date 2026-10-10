"""The observability seam: the core calls `await probe.<point>(...)` at each step worth watching.

The base class does nothing, so a Session without a probe emits only protocol events.
educodex.observe.Tracer subclasses it to emit the trace/* events and run step mode.
Codex instruments the same places with OpenTelemetry (codex-rs/otel/, e.g. `otel.sandbox_outcome(...)`).
"""

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from educodex.core.items import ResponseItem
    from educodex.core.session import Session
    from educodex.core.tools.registry import ToolCall
    from educodex.core.turn import TurnContext


class Probe:
    # --- session --------------------------------------------------------------------------
    async def thread_started(self, session: "Session") -> None:
        """Tools are built (MCP servers connected); the thread is about to start."""

    async def mcp_server_listed(self, session: "Session", server: str, server_info: dict, tools: list[dict],
                                spec: dict) -> None:
        pass

    async def mcp_server_failed(self, session: "Session", server: str, error: str) -> None:
        pass

    async def history_appended(self, session: "Session", items: list["ResponseItem"]) -> None:
        pass

    # --- turn loop ------------------------------------------------------------------------
    async def context_built(self, ctx: "TurnContext", fragments: list, changed: list, first_turn: bool) -> None:
        pass

    async def checkpoint(self, ctx: "TurnContext", name: str, **info: Any) -> None:
        """A named point in the loop (beforeModelRequest, beforeToolCall, afterToolCall)."""

    async def model_request(self, ctx: "TurnContext", body: dict) -> None:
        pass

    async def sse_event(self, ctx: "TurnContext", data: dict) -> None:
        pass

    async def model_response(self, ctx: "TurnContext", body: dict, output_items: list["ResponseItem"],
                             usage: dict | None, event_counts: dict[str, int], seconds: float) -> None:
        pass

    async def loop_iteration(self, ctx: "TurnContext", needs_follow_up: bool, tokens: int, limit: int,
                             context_window: int) -> None:
        pass

    # --- tools, policy, sandbox, approvals, hooks -------------------------------------------
    async def tool_call(self, ctx: "TurnContext", call: "ToolCall", item: "ResponseItem", parallel: bool) -> None:
        pass

    async def tool_output(self, ctx: "TurnContext", call: "ToolCall", output: str) -> None:
        pass

    async def policy_decision(self, ctx: "TurnContext", tool: str, decision: str, sandboxed: bool, reason: str,
                              matched_rules: list, **target: Any) -> None:
        """`target` says what was checked: command=... or paths=[...]."""

    async def sandbox_command(self, ctx: "TurnContext", argv: list[str], policy: str | None, params: dict,
                              warning: str | None = None) -> None:
        pass

    async def sandbox_denied(self, ctx: "TurnContext", command: str, exit_code: int | None) -> None:
        pass

    async def approval_requested(self, ctx: "TurnContext", method: str, params: dict) -> None:
        pass

    async def approval_resolved(self, ctx: "TurnContext", method: str, decision: str) -> None:
        pass

    async def hook_ran(self, ctx: "TurnContext", event: str, command: str, exit_code: int, stdout: str,
                       stderr: str) -> None:
        pass

    # --- compaction -----------------------------------------------------------------------
    async def compaction_requested(self, ctx: "TurnContext", reason: str, body: dict, tokens_before: int) -> None:
        pass

    async def compacted(self, ctx: "TurnContext", reason: str, summary: str, items_before: int, tokens_before: int,
                        new_history: list["ResponseItem"]) -> None:
        pass
