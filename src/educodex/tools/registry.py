"""Tool registry and router: which tools exist, and dispatching a model's tool call to a handler.

Mirrors codex-rs/core/src/tools/{spec_plan.rs, registry.rs, router.rs}.
"""

import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

from educodex.items import ResponseItem

if TYPE_CHECKING:
    from educodex.turn import TurnContext


class ToolError(Exception):
    """A failure the model should see as the tool's output (not a crash)."""


class TurnAborted(Exception):
    """The user cancelled (e.g. chose `cancel` at an approval prompt)."""


@dataclass
class ToolCall:
    item: ResponseItem  # the raw function_call / custom_tool_call item from the model
    name: str
    call_id: str
    arguments: dict[str, Any]  # parsed JSON arguments (function tools)
    input: str  # raw text input (freeform tools)

    @classmethod
    def from_item(cls, item: ResponseItem) -> "ToolCall":
        if item["type"] == "custom_tool_call":
            return cls(item, item["name"], item["call_id"], {}, item.get("input", ""))
        try:
            args = json.loads(item.get("arguments") or "{}")
        except json.JSONDecodeError as err:
            args = {"__parse_error__": str(err)}
        # Namespaced (MCP) calls come back as {"namespace": "mcp__server", "name": "tool"}.
        name = f"{item['namespace']}__{item['name']}" if item.get("namespace") else item["name"]
        return cls(item, name, item["call_id"], args, "")


class ToolHandler(Protocol):
    name: str
    supports_parallel: bool  # Codex default is False: such tools run one at a time

    def spec(self) -> dict[str, Any]: ...

    async def handle(self, call: ToolCall, ctx: "TurnContext") -> str: ...


class ToolRouter:
    def __init__(self, handlers: list[ToolHandler], extra_specs: list[dict[str, Any]] | None = None) -> None:
        self.handlers = {h.name: h for h in handlers}
        self.extra_specs = extra_specs or []  # e.g. MCP namespace specs whose tools are routed by full name

    def specs(self) -> list[dict[str, Any]]:
        """Tool specs in a stable order: a changing order would break the prompt cache."""
        seen, specs = set(), []
        for handler in self.handlers.values():
            spec = handler.spec()
            if spec and spec.get("name") not in seen:
                seen.add(spec.get("name"))
                specs.append(spec)
        return specs + self.extra_specs

    def get(self, name: str) -> ToolHandler | None:
        return self.handlers.get(name)

    async def dispatch(self, call: ToolCall, ctx: "TurnContext") -> str:
        handler = self.get(call.name)
        if handler is None:  # wording from core/src/tools/registry.rs
            kind = "custom tool call" if call.item["type"] == "custom_tool_call" else "call"
            return f"unsupported {kind}: {call.name}"
        if "__parse_error__" in call.arguments:
            return f"failed to parse function arguments: {call.arguments['__parse_error__']}"
        try:
            return await handler.handle(call, ctx)
        except ToolError as err:
            return str(err)
        except (TypeError, ValueError, KeyError, AttributeError) as err:  # bad arguments from the model
            return f"failed to parse function arguments: {err}"
