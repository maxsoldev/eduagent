"""Message processor: turns client requests into session operations, and session events into
notifications. Mirrors codex-rs/app-server/src/codex_message_processor.rs + thread manager.

Codex methods (same names and main fields as app-server protocol v2):
  initialize, thread/start, thread/list, thread/read, turn/start, turn/interrupt,
  thread/compact/start, model/list, skills/list, memory/reset
educodex extensions (not in Codex):
  debug/stepMode/set, debug/continue, debug/context/get,
  memory/update/start (Codex runs the memory pipeline on its own; its TUI command is a stub)
"""

import platform
import sys
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

import httpx

from educodex import __version__
from educodex.app_server.connection import INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND, Connection, RpcError
from educodex.core.config import Config, load_api_key
from educodex.core.events import Event, EventBus
from educodex.core.memories.start import clear_memories
from educodex.core.models import catalog
from educodex.core.session import Session
from educodex.core.skills.loader import load_skills
from educodex.observe.tracer import Tracer


class ThreadState:
    """A session plus what clients need to redraw it (turns and their completed items)."""

    def __init__(self, session: Session, tracer: Tracer, owner: Connection) -> None:
        self.session = session
        self.tracer = tracer  # the session's probe: trace/* events, step mode
        self.owner = owner  # the connection that receives approval requests
        self.subscribers: set[Connection] = {owner}  # connections that get this thread's notifications
        self.turns: list[dict[str, Any]] = []
        self.trace: list[dict[str, Any]] = []  # every event, so a reconnecting UI can rebuild its timeline


class MessageProcessor:
    def __init__(
        self, defaults: Config, transport_factory: Callable[[], httpx.AsyncBaseTransport] | None = None
    ) -> None:
        self.defaults = defaults
        self.transport_factory = transport_factory
        self.threads: dict[str, ThreadState] = {}
        self.connections: list[Connection] = []

    # --- connection lifecycle ---------------------------------------------------------------
    def connect(self, conn: Connection) -> None:
        self.connections.append(conn)

    def disconnect(self, conn: Connection) -> None:
        conn.cancel_pending()
        if conn in self.connections:
            self.connections.remove(conn)
        for state in self.threads.values():
            state.subscribers.discard(conn)

    async def handle(self, conn: Connection, message: dict[str, Any]) -> None:
        """Entry point for every incoming message."""
        if "method" not in message:
            conn.resolve(message)  # a response to one of our approval requests
            return
        method, params, request_id = message["method"], message.get("params") or {}, message.get("id")
        if request_id is None:  # notification, e.g. "initialized"
            return
        try:
            handler = self.METHODS.get(method)
            if handler is None:
                raise RpcError(METHOD_NOT_FOUND, f"method not found: {method}")
            if method != "initialize" and not conn.initialized:
                raise RpcError(-32600, "not initialized: send initialize first")
            result = await handler(self, conn, params)
            await conn.send({"id": request_id, "result": result})
        except RpcError as err:
            await conn.send({"id": request_id, "error": {"code": err.code, "message": str(err)}})
        except (KeyError, TypeError, ValueError) as err:
            await conn.send({"id": request_id, "error": {"code": INVALID_PARAMS, "message": f"invalid params: {err}"}})
        except Exception as err:  # every request gets an answer, or the client would wait forever
            await conn.send(
                {"id": request_id, "error": {"code": INTERNAL_ERROR, "message": f"{type(err).__name__}: {err}"}}
            )

    # --- events -> notifications ------------------------------------------------------------
    async def _broadcast(self, event: Event) -> None:
        thread_id = event.params.get("threadId") or event.params.get("thread", {}).get("id")
        state = self.threads.get(thread_id)
        if state is None:
            return
        state.trace.append({"seq": event.seq, "ts": event.ts, "method": event.method, "params": event.params})
        self._track_items(state, event)
        for conn in list(state.subscribers):
            try:
                # _seq/_ts are educodex extensions so the UI can order and time its timeline.
                await conn.notify(event.method, {**event.params, "_seq": event.seq, "_ts": event.ts})
            except Exception:
                self.disconnect(conn)

    def _track_items(self, state: ThreadState, event: Event) -> None:
        p = event.params
        if event.method == "turn/started":
            state.turns.append({**p["turn"], "items": []})
        elif event.method == "turn/completed":
            items = next((t["items"] for t in state.turns if t["id"] == p["turn"]["id"]), [])
            for i, t in enumerate(state.turns):
                if t["id"] == p["turn"]["id"]:
                    state.turns[i] = {**p["turn"], "items": items}
        elif event.method == "item/completed" and state.turns:
            state.turns[-1]["items"].append(p["item"])

    # --- methods -----------------------------------------------------------------------------
    async def initialize(self, conn: Connection, params: dict) -> dict:
        if conn.initialized:
            raise RpcError(-32600, "Already initialized")
        conn.initialized = True
        conn.opt_out = set((params.get("capabilities") or {}).get("optOutNotificationMethods") or [])
        return {
            "userAgent": f"educodex/{__version__}",
            "codexHome": str(self.defaults.home),
            "platformFamily": "unix" if sys.platform != "win32" else "windows",
            "platformOs": platform.system().lower(),
        }

    async def thread_start(self, conn: Connection, params: dict) -> dict:
        cwd = Path(params.get("cwd") or self.defaults.cwd)
        config = Config(
            cwd=cwd,
            model=params.get("model") or self.defaults.model,
            base_url=self.defaults.base_url,
            api_key=self.defaults.api_key or load_api_key(cwd),
            approval_policy=params.get("approvalPolicy") or self.defaults.approval_policy,
            sandbox_mode=params.get("sandbox") or self.defaults.sandbox_mode,
            network_access=self.defaults.network_access,
            developer_instructions=params.get("developerInstructions") or self.defaults.developer_instructions,
            base_instructions=params.get("baseInstructions"),
            reasoning_effort=params.get("effort") or self.defaults.reasoning_effort,
            home=self.defaults.home,
            mcp_servers=self.defaults.mcp_servers,
            rules=self.defaults.rules,
            hooks=self.defaults.hooks,
            memories=self.defaults.memories,
        )
        bus = EventBus()
        bus.subscribe(self._broadcast)
        state: ThreadState | None = None

        async def ask_client(method: str, request: dict) -> Any:
            return await state.owner.request(method, request)

        tracer = Tracer(trace_sse=bool(params.get("traceSse")))
        session = Session(
            config,
            bus,
            ask_client,
            transport=self.transport_factory() if self.transport_factory else None,
            probe=tracer,
        )
        state = ThreadState(session, tracer, conn)
        self.threads[session.thread_id] = state
        thread = await session.start()
        return {
            "thread": thread,
            "model": config.model,
            "modelProvider": "openrouter",
            "cwd": str(config.cwd),
            "approvalPolicy": config.approval_policy,
            "sandbox": {"type": SANDBOX_POLICY_TAGS[config.sandbox_mode]},
            "reasoningEffort": session.client.reasoning_effort,
        }

    def _state(self, params: dict) -> ThreadState:
        state = self.threads.get(params["threadId"])
        if state is None:
            raise RpcError(INVALID_PARAMS, f"unknown thread {params['threadId']}")
        return state

    async def thread_list(self, conn: Connection, params: dict) -> dict:
        return {"data": [s.session.thread_info() for s in self.threads.values()], "nextCursor": None}

    async def thread_read(self, conn: Connection, params: dict) -> dict:
        state = self._state(params)
        state.subscribers.add(conn)
        result = {"thread": {**state.session.thread_info(), "turns": state.turns}}
        if params.get("includeTrace"):  # educodex extension: full event log for UIs
            result["trace"] = state.trace
        return result

    async def turn_start(self, conn: Connection, params: dict) -> dict:
        state = self._state(params)
        state.owner = conn
        state.subscribers.add(conn)
        inputs = params.get("input", [])
        text = "\n".join(i.get("text", "") for i in inputs if i.get("type") == "text")
        skill_inputs = [
            {"type": "skill", "name": i["name"], "path": i["path"]} for i in inputs if i.get("type") == "skill"
        ]
        if not text.strip():
            raise RpcError(INVALID_PARAMS, "input must contain at least one text item")
        if state.session.turn_running:  # reject before touching the running turn's settings
            raise RpcError(-32600, "a turn is already running")
        sandbox = params.get("sandboxPolicy")
        state.session.apply_overrides(
            cwd=Path(params["cwd"]) if params.get("cwd") else None,
            approval_policy=params.get("approvalPolicy"),
            sandbox_mode=sandbox_mode_from_policy(sandbox) if sandbox else None,
            model=params.get("model"),
            reasoning_effort=params.get("effort"),
        )
        try:
            turn = state.session.start_turn(text, skill_inputs)
        except RuntimeError as err:
            raise RpcError(-32600, str(err)) from err
        return {"turn": turn}

    async def turn_interrupt(self, conn: Connection, params: dict) -> dict:
        self._state(params).session.interrupt()  # cancelling the turn also cancels its pending approval
        return {}

    async def thread_compact_start(self, conn: Connection, params: dict) -> dict:
        # Like Codex: reply right away; progress arrives as item/started, item/completed notifications.
        try:
            self._state(params).session.start_compaction()
        except RuntimeError as err:
            raise RpcError(-32600, str(err)) from err
        return {}

    async def memory_update_start(self, conn: Connection, params: dict) -> dict:
        # Like thread/compact/start: reply now; a memoryUpdate item and trace/memory* events follow.
        try:
            self._state(params).session.start_memory_update()
        except RuntimeError as err:
            raise RpcError(-32600, str(err)) from err
        return {}

    async def memory_reset(self, conn: Connection, params: dict) -> dict:
        clear_memories(self.defaults.home)
        return {}

    async def skills_list(self, conn: Connection, params: dict) -> dict:
        """Skills for each cwd, scanned now (Codex caches them unless forceReload is set)."""
        data = []
        for cwd in params.get("cwds") or [str(self.defaults.cwd)]:
            outcome = load_skills(replace(self.defaults, cwd=Path(cwd)))
            skills = [
                {
                    "name": s.name,
                    "description": s.description,
                    "shortDescription": s.short_description,
                    "path": str(s.path),
                    "scope": s.scope,
                    "enabled": True,
                    "pluginId": None,
                }
                for s in outcome.skills
            ]
            errors = [{"path": str(e.path), "message": e.message} for e in outcome.errors]
            data.append({"cwd": str(Path(cwd).resolve()), "skills": skills, "errors": errors})
        return {"data": data}

    async def model_list(self, conn: Connection, params: dict) -> dict:
        data = [
            {
                "id": f"openai/{slug}",
                "model": slug,
                "displayName": m.get("display_name", slug),
                "description": m.get("description", ""),
                "isDefault": f"openai/{slug}" == self.defaults.model,
                "defaultReasoningEffort": m.get("default_reasoning_level"),
            }
            for slug, m in catalog().items()
            if m.get("visibility") == "list"
        ]
        return {"data": data, "nextCursor": None}

    async def debug_step_mode_set(self, conn: Connection, params: dict) -> dict:
        stepper = self._state(params).tracer.stepper
        stepper.configure(bool(params.get("enabled")), params.get("breakpoints"))
        return {"enabled": stepper.enabled, "breakpoints": sorted(stepper.breakpoints)}

    async def debug_continue(self, conn: Connection, params: dict) -> dict:
        self._state(params).tracer.stepper.release()
        return {}

    async def debug_context_get(self, conn: Connection, params: dict) -> dict:
        """Exactly what the next request would contain."""
        session = self._state(params).session
        body = session.client.build_request(_prompt_for(session))
        return {
            "request": body,
            "historyItems": len(session.history.items),
            "tokens": session.history.token_count(),
            "contextWindow": session.model_info.context_window,
            "autoCompactLimit": session.model_info.effective_auto_compact_limit(),
        }

    METHODS = {
        "initialize": initialize,
        "thread/start": thread_start,
        "thread/list": thread_list,
        "thread/read": thread_read,
        "turn/start": turn_start,
        "turn/interrupt": turn_interrupt,
        "thread/compact/start": thread_compact_start,
        "model/list": model_list,
        "skills/list": skills_list,
        "memory/reset": memory_reset,
        "memory/update/start": memory_update_start,
        "debug/stepMode/set": debug_step_mode_set,
        "debug/continue": debug_continue,
        "debug/context/get": debug_context_get,
    }

    async def shutdown(self) -> None:
        for state in self.threads.values():
            await state.session.close()


def _prompt_for(session: Session):
    from educodex.core.client import Prompt

    return Prompt(
        input=session.history.for_prompt(),
        tools=session.router.specs(),
        base_instructions=session.base_instructions,
        parallel_tool_calls=session.model_info.supports_parallel_tool_calls,
    )


# SandboxPolicy in app-server v2 uses camelCase tags (v2/permissions.rs); config uses kebab-case modes.
SANDBOX_POLICY_TAGS = {
    "read-only": "readOnly",
    "workspace-write": "workspaceWrite",
    "danger-full-access": "dangerFullAccess",
}


def sandbox_mode_from_policy(policy: Any) -> str:
    tag = policy.get("type") if isinstance(policy, dict) else policy
    modes = {v: k for k, v in SANDBOX_POLICY_TAGS.items()}
    if tag in modes:
        return modes[tag]
    if tag in SANDBOX_POLICY_TAGS:  # also accept kebab-case
        return tag
    raise ValueError(f"unknown sandboxPolicy type {tag!r}")
