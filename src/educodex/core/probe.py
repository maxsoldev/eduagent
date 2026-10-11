"""The observability seam: the core calls `await probe.<point>(...)` at each step worth watching.

The base class does nothing, so a Session without a probe emits only protocol events.
educodex.observe.Tracer subclasses it to emit the trace/* events and run step mode.
Codex instruments the same places with OpenTelemetry (codex-rs/otel/, e.g. `otel.sandbox_outcome(...)`).
"""

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from educodex.core.client import ResponseEvent
    from educodex.core.items import ResponseItem
    from educodex.core.session import Session
    from educodex.core.tools.registry import ToolCall
    from educodex.core.turn import TurnContext


class Probe:
    # --- session --------------------------------------------------------------------------
    async def thread_started(self, session: "Session") -> None:
        """Tools are built (MCP servers connected); thread/started comes next."""

    async def mcp_server_listed(self, session: "Session", server: str, server_info: dict, tools: list[dict],
                                spec: dict) -> None:
        """An MCP server answered tools/list; `spec` is the namespace tool the model will see."""

    async def mcp_server_failed(self, session: "Session", server: str, error: str) -> None:
        """An MCP server could not be started or listed."""

    async def history_appended(self, session: "Session", items: list["ResponseItem"]) -> None:
        """Items were recorded in history."""

    # --- turn loop ------------------------------------------------------------------------
    async def context_built(self, ctx: "TurnContext", fragments: list, changed: list, first_turn: bool) -> None:
        """Context fragments were built; only `changed` ones get appended to history."""

    async def checkpoint(self, ctx: "TurnContext", name: str, **info: Any) -> None:
        """A named point in the loop: beforeModelRequest (body=...), beforeToolCall, afterToolCall."""

    async def model_request(self, ctx: "TurnContext", body: dict) -> None:
        """The request body is about to be POSTed to /responses."""

    async def sse_event(self, ctx: "TurnContext", event: "ResponseEvent") -> None:
        """One parsed SSE event of the current response."""

    async def model_response(self, ctx: "TurnContext", body: dict, usage: dict | None) -> None:
        """The response stream finished; `usage` is from response.completed."""

    async def loop_iteration(self, ctx: "TurnContext", needs_follow_up: bool, tokens: int, limit: int,
                             context_window: int) -> None:
        """The loop decides whether to call the model again."""

    # --- tools, policy, sandbox, approvals, hooks -------------------------------------------
    async def tool_call(self, ctx: "TurnContext", call: "ToolCall", item: "ResponseItem", parallel: bool) -> None:
        """A tool call is about to be dispatched."""

    async def tool_output(self, ctx: "TurnContext", call: "ToolCall", output: str) -> None:
        """A tool call finished; `output` is what the model will see."""

    async def policy_decision(self, ctx: "TurnContext", tool: str, decision: str, sandboxed: bool, reason: str,
                              matched_rules: list, **target: Any) -> None:
        """Approval policy decided allow/prompt/forbidden; `target` is command=... or paths=[...]."""

    async def sandbox_command(self, ctx: "TurnContext", argv: list[str], policy: str | None, params: dict,
                              warning: str | None = None) -> None:
        """A command is about to run in the OS sandbox (policy None: no sandbox available)."""

    async def sandbox_denied(self, ctx: "TurnContext", command: str, exit_code: int | None) -> None:
        """The output looks like the sandbox blocked the command."""

    async def approval_requested(self, ctx: "TurnContext", method: str, params: dict) -> None:
        """An approval request is about to be sent to the client."""

    async def approval_resolved(self, ctx: "TurnContext", method: str, decision: str) -> None:
        """The client answered an approval request."""

    async def hook_ran(self, ctx: "TurnContext", event: str, command: str, exit_code: int, stdout: str,
                       stderr: str) -> None:
        """A configured hook command finished."""

    # --- compaction -----------------------------------------------------------------------
    async def compaction_requested(self, ctx: "TurnContext", reason: str, body: dict, tokens_before: int) -> None:
        """The summary request is about to be sent."""

    async def compacted(self, ctx: "TurnContext", reason: str, summary: str, items_before: int, tokens_before: int,
                        new_history: list["ResponseItem"]) -> None:
        """History was replaced by the compacted history."""
