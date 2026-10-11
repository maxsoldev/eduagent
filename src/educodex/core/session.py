"""A session runs one thread (conversation): its history, model client, tools and policies.

Mirrors codex-rs/core/src/session/session.rs + thread_manager.rs, much simplified: one turn runs
at a time, and the session talks to its host (app server, CLI, tests) only through the event bus,
one callback for questions to the user (approvals), and an optional probe for observers (probe.py).
"""

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

import httpx

from educodex.core.client import ModelClient
from educodex.core.config import Config
from educodex.core.events import EventBus
from educodex.core.history import History
from educodex.core.items import ResponseItem
from educodex.core.mcp.manager import McpManager
from educodex.core.models import model_info
from educodex.core.policy.rules import load_rules
from educodex.core.probe import Probe
from educodex.core.rollout import RolloutRecorder
from educodex.core.tools.handlers import builtin_handlers
from educodex.core.tools.processes import ProcessManager
from educodex.core.tools.registry import ToolRouter
from educodex.core.turn import new_turn, run_turn

# Called for server-initiated requests (approvals). Returns the client's JSON-RPC result.
ClientRequest = Callable[[str, dict[str, Any]], Awaitable[Any]]


async def _deny_all(method: str, params: dict[str, Any]) -> dict:
    return {"decision": "decline", "action": "decline"}


class Session:
    def __init__(
        self,
        config: Config,
        bus: EventBus | None = None,
        request_client: ClientRequest = _deny_all,
        transport: httpx.AsyncBaseTransport | None = None,
        thread_id: str | None = None,
        probe: Probe | None = None,
    ) -> None:
        self.config = config
        self.bus = bus or EventBus()
        self.request_client = request_client
        self.thread_id = thread_id or str(uuid.uuid4())
        self.history = History()
        self.processes = ProcessManager()
        self.probe = probe or Probe()
        self.mcp = McpManager(config.mcp_servers)
        self.rules = load_rules(config.home, config.rules)
        self.approved_commands: set[str] = set()
        self.approved_patch_paths: set[Path] = set()
        self.running_items: dict[int, dict] = {}  # exec items whose process is still running
        self.total_usage: dict[str, int] = {}  # summed over all model requests
        self.context_snapshot: dict[str, str] | None = None  # last emitted context fragments
        self.rollout = RolloutRecorder(config.home, self.thread_id)
        self._transport = transport
        self._turn_task: asyncio.Task | None = None
        self._configure_model()

    def _configure_model(self) -> None:
        self.model_info = model_info(self.config.model)
        self.base_instructions = self.config.base_instructions or self.model_info.base_instructions
        self.client = ModelClient(
            self.config.model, self.model_info, self.config.api_key, self.config.base_url, self.thread_id,
            self.config.reasoning_effort, self.config.reasoning_summary, self._transport,
        )

    async def start(self) -> dict:
        """Connect MCP servers, build the tool list, write the session log header."""
        await self.mcp.start(self)
        self.router = ToolRouter(builtin_handlers(self.config.include_plan_tool, self.model_info.apply_patch_tool_type) + self.mcp.handlers(),
                                 self.mcp.namespace_specs())
        await self.probe.thread_started(self)
        self.rollout.session_meta(self.config, self.base_instructions)
        thread = self.thread_info()
        await self.bus.emit("thread/started", thread=thread)
        return thread

    def thread_info(self) -> dict:
        return {"id": self.thread_id, "preview": "", "modelProvider": "openrouter", "model": self.config.model,
                "cwd": str(self.config.cwd), "path": str(self.rollout.path), "status": "idle", "ephemeral": False}

    async def record(self, *items: ResponseItem) -> None:
        """Append to history (and the session log), and tell observers."""
        self.history.record(*items)
        for item in items:
            self.rollout.response_item(item)
        await self.probe.history_appended(self, list(items))

    def apply_overrides(self, **overrides: Any) -> None:
        """Per-turn settings from turn/start (cwd, approvalPolicy, sandbox, model, effort)."""
        values = {k: v for k, v in overrides.items() if v is not None}
        if not values:
            return
        model_changed = "model" in values and values["model"] != self.config.model
        self.config = replace(self.config, **values)
        if model_changed or "reasoning_effort" in values:
            old = self.client
            self._configure_model()
            asyncio.get_running_loop().create_task(old.aclose())

    @property
    def turn_running(self) -> bool:
        return bool(self._turn_task and not self._turn_task.done())

    def start_turn(self, text: str) -> dict:
        """Start a turn in the background and return its Turn object (status inProgress)."""
        if self.turn_running:
            raise RuntimeError("a turn is already running")
        turn = new_turn()
        self._turn_task = asyncio.create_task(run_turn(self, text, turn))
        return {**turn, "items": []}

    def start_compaction(self) -> None:
        """Manual compaction runs as the session's task, so it can never overlap a turn (Codex CompactTask)."""
        from educodex.core.compact import run_compact
        from educodex.core.turn import TurnContext

        if self.turn_running:
            raise RuntimeError("a turn is already running")
        ctx = TurnContext(self, turn_id=f"compact-{uuid.uuid4()}")
        self._turn_task = asyncio.create_task(run_compact(ctx, reason="manual"))

    async def run(self, text: str) -> dict:
        """Run one turn to completion (CLI and tests)."""
        self.start_turn(text)
        return await self._turn_task

    def interrupt(self) -> bool:
        if self._turn_task and not self._turn_task.done():
            self._turn_task.cancel()
            return True
        return False

    async def close(self) -> None:
        self.interrupt()
        await self.processes.terminate_all()
        await self.mcp.close()
        await self.client.aclose()
        self.rollout.close()
