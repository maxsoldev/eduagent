"""Connect to MCP servers, expose their tools to the model, and call them.

Mirrors codex-rs/codex-mcp/ (connection manager), core/src/mcp_tool_exposure.rs and
core/src/mcp_tool_call.rs. Flow:
  1. start each configured server as a child process and speak MCP over stdio (official `mcp` SDK)
  2. tools/list -> sanitise names and schemas -> one `namespace` tool spec per server
  3. on a call: decide whether approval is needed (from tool annotations), then tools/call

Note from Codex: the OS sandbox only wraps Codex's own shell tool. MCP servers run outside it
and must enforce their own guardrails.
"""

import hashlib
import json
from contextlib import AsyncExitStack
from typing import TYPE_CHECKING, Any

from educodex.mcp.naming import namespace_for, qualified, sanitize
from educodex.mcp.schema import sanitize_schema
from educodex.tools.output import truncate_middle
from educodex.tools.registry import ToolCall, TurnAborted

if TYPE_CHECKING:
    from educodex.session import Session
    from educodex.turn import TurnContext


def needs_approval(annotations: dict[str, Any] | None) -> bool:
    """Codex's `auto` approval mode (mcp_tool_call.rs): destructive or possibly side-effecting tools ask."""
    a = annotations or {}
    if a.get("destructiveHint") is True:
        return True
    if a.get("readOnlyHint") is True:
        return False
    return a.get("destructiveHint") is not False or a.get("openWorldHint") is not False


class McpToolHandler:
    def __init__(self, manager: "McpManager", server: str, namespace: str, tool: dict[str, Any]) -> None:
        self.manager, self.server, self.namespace, self.tool = manager, server, namespace, tool
        self.callable_name = sanitize(tool["name"])
        self.name = qualified(namespace, self.callable_name)
        annotations = tool.get("annotations") or {}
        self.supports_parallel = annotations.get("readOnlyHint") is True  # read-only tools may overlap

    def spec(self) -> dict[str, Any] | None:
        return None  # exposed through the server's namespace spec instead

    def function_spec(self) -> dict[str, Any]:
        return {"type": "function", "name": self.callable_name, "description": self.tool.get("description") or "",
                "strict": False, "parameters": sanitize_schema(self.tool.get("inputSchema") or {"type": "object"})}

    async def handle(self, call: ToolCall, ctx: "TurnContext") -> str:
        item = {"type": "mcpToolCall", "id": call.call_id, "server": self.server, "tool": self.tool["name"],
                "status": "inProgress", "arguments": call.arguments, "result": None, "error": None, "durationMs": None}
        await ctx.item_started(item)
        annotations = self.tool.get("annotations")
        approval = needs_approval(annotations)
        policy, sandbox = ctx.config.approval_policy, ctx.config.sandbox_mode
        decision = "allow" if not approval or (policy == "never" and sandbox == "danger-full-access") else (
            "forbidden" if policy == "never" else "prompt")
        await ctx.trace("trace/policyDecision", tool=call.name, decision=decision, sandboxed=False, matchedRules=[],
                        reason=f"MCP annotations {annotations or {}} -> {'needs' if approval else 'no'} approval",
                        approvalPolicy=policy, sandboxMode=sandbox)
        if decision == "forbidden":
            return await self._finish(ctx, item, "failed", error="rejected: tool needs approval but approval_policy is never")
        if decision == "prompt":
            # Codex asks via an MCP-style elicitation (app-server v2 mcpServer/elicitation/request).
            action, _ = await ctx.request_approval("mcpServer/elicitation/request", {
                "threadId": ctx.thread_id, "turnId": ctx.turn_id, "serverName": self.server, "mode": "form",
                "message": f"Allow the {self.server} MCP server to run tool \"{self.tool['name']}\"?",
                "requestedSchema": {"type": "object", "properties": {}},
                "_meta": {"tool": self.tool["name"], "arguments": call.arguments, "annotations": annotations}})
            if action == "cancel":
                raise TurnAborted("cancelled at MCP approval")
            if action != "accept":
                return await self._finish(ctx, item, "failed", error="user rejected MCP tool call")
        try:
            result = await self.manager.call(self.server, self.tool["name"], call.arguments)
        except Exception as err:  # transport errors become tool output
            return await self._finish(ctx, item, "failed", error=f"tool call error: {err}")
        return await self._finish(ctx, item, "failed" if result.get("isError") else "completed", result=result)

    async def _finish(self, ctx, item, status, result=None, error=None) -> str:
        item.update(status=status, result=result, error={"message": error} if error else None)
        await ctx.item_completed(item)
        if result is None:
            return error
        text, _ = truncate_middle(model_text(result), ctx.model_info.truncation_limit_tokens)
        return text


def model_text(result: dict[str, Any]) -> str:
    """What the model sees from a CallToolResult (protocol/src/models.rs): structuredContent as JSON
    if present, else the content items (text joined; other items as JSON)."""
    if result.get("structuredContent") is not None:
        return json.dumps(result["structuredContent"], ensure_ascii=False)
    parts = [c["text"] if c.get("type") == "text" else json.dumps(c) for c in result.get("content", [])]
    return "\n".join(parts)


class McpManager:
    def __init__(self, servers: dict[str, dict[str, Any]]) -> None:
        self.servers = servers
        self._stack = AsyncExitStack()
        self._sessions: dict[str, Any] = {}
        self._handlers: list[McpToolHandler] = []
        self._raw: dict[str, list[dict]] = {}
        self._errors: dict[str, str] = {}

    async def start(self, session: "Session") -> None:
        if not self.servers:
            return
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client

        for name in sorted(self.servers):  # stable order keeps the tool list (and prompt cache) stable
            cfg = self.servers[name]
            try:
                params = StdioServerParameters(command=cfg["command"], args=cfg.get("args", []), env=cfg.get("env"),
                                               cwd=cfg.get("cwd"))
                read, write = await self._stack.enter_async_context(stdio_client(params))
                client = await self._stack.enter_async_context(ClientSession(read, write))
                init = await client.initialize()
                listed = await client.list_tools()
            except Exception as err:
                self._errors[name] = str(err)
                await session.bus.emit("trace/mcpServerFailed", threadId=session.thread_id, server=name, error=str(err))
                continue
            self._sessions[name] = client
            tools = sorted((t.model_dump(exclude_none=True, by_alias=True) for t in listed.tools), key=lambda t: t["name"])
            self._raw[name] = tools
            namespace = namespace_for(name)
            handlers = _dedupe([McpToolHandler(self, name, namespace, t) for t in tools])
            self._handlers += handlers
            await session.bus.emit("trace/mcpToolsListed", threadId=session.thread_id, server=name,
                                   serverInfo=_server_info(init), tools=tools)
            await session.bus.emit("trace/mcpToolExposed", threadId=session.thread_id, server=name,
                                   spec=self._namespace_spec(name, namespace, handlers))

    def _namespace_spec(self, server: str, namespace: str, handlers: list[McpToolHandler]) -> dict[str, Any]:
        return {"type": "namespace", "name": namespace, "description": f"Tools in the {namespace} namespace.",
                "tools": [h.function_spec() for h in handlers]}

    def handlers(self) -> list[McpToolHandler]:
        return list(self._handlers)

    def namespace_specs(self) -> list[dict[str, Any]]:
        specs = []
        for server in sorted(self._sessions):
            handlers = [h for h in self._handlers if h.server == server]
            if handlers:
                specs.append(self._namespace_spec(server, handlers[0].namespace, handlers))
        return specs

    def summary(self) -> dict[str, Any]:
        return {name: {"status": "failed" if name in self._errors else "ready", "error": self._errors.get(name),
                       "tools": [t["name"] for t in self._raw.get(name, [])]} for name in sorted(self.servers)}

    async def call(self, server: str, tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
        result = await self._sessions[server].call_tool(tool, arguments)
        return result.model_dump(exclude_none=True, by_alias=True)

    async def close(self) -> None:
        try:
            await self._stack.aclose()
        except Exception:
            pass


def _dedupe(handlers: list[McpToolHandler]) -> list[McpToolHandler]:
    """Two tools can sanitise to the same name (`a.b` and `a_b`): add a short hash, like Codex."""
    seen: set[str] = set()
    for h in handlers:
        if h.callable_name in seen:
            h.callable_name = f"{h.callable_name}_{hashlib.sha1(h.tool['name'].encode()).hexdigest()[:12]}"
            h.name = qualified(h.namespace, h.callable_name)
        seen.add(h.callable_name)
    return handlers


def _server_info(init: Any) -> dict[str, Any]:
    info = getattr(init, "server_info", None) or getattr(init, "serverInfo", None)
    return info.model_dump(exclude_none=True, by_alias=True) if info else {}
