"""The agentic loop: one user turn = many model calls and tool calls, until the model stops.

Mirrors codex-rs/core/src/session/turn.rs (`run_turn`, `run_sampling_request`) and
core/src/stream_events_utils.rs (`handle_output_item_done`).

    run_turn
      ├─ append context updates + the user's message to history
      └─ loop:
           ├─ run_sampling_request: send history, stream the reply, record output items
           ├─ run the tool calls the model asked for, record their outputs
           ├─ context nearly full? -> compact and continue
           └─ no tool calls? -> the model gave its answer: stop

Simplification: Codex starts each tool while the response is still streaming; we wait for
the stream to finish first. The order of items in history is the same either way.
"""

import asyncio
import contextlib
import time
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from educodex import compact, hooks
from educodex.client import Prompt
from educodex.context import world_state
from educodex.pricing import add_totals, cost_breakdown
from educodex.items import ResponseItem, approx_tokens, clean_output_item, is_tool_call, message_text, tool_output, user_message
from educodex.tools.registry import ToolCall, TurnAborted

if TYPE_CHECKING:
    from educodex.session import Session


@dataclass
class TurnContext:
    """What a tool handler can see and do during one turn."""

    session: "Session"
    turn_id: str
    iteration: int = 0

    # --- shortcuts into the session -------------------------------------------------------
    @property
    def config(self):
        return self.session.config

    @property
    def thread_id(self) -> str:
        return self.session.thread_id

    @property
    def model_info(self):
        return self.session.model_info

    @property
    def processes(self):
        return self.session.processes

    @property
    def rules(self):
        return self.session.rules

    @property
    def approved_commands(self) -> set[str]:
        return self.session.approved_commands

    def patch_paths_approved_for_session(self, paths) -> bool:
        return bool(paths) and all(p in self.session.approved_patch_paths for p in paths)

    # --- events ----------------------------------------------------------------------------
    async def emit(self, method: str, **params: Any) -> None:
        await self.session.bus.emit(method, threadId=self.thread_id, turnId=self.turn_id, **params)

    async def trace(self, method: str, **params: Any) -> None:
        await self.emit(method, iteration=self.iteration, **params)

    async def item_started(self, item: dict) -> None:
        await self.emit("item/started", item=item, startedAtMs=_now_ms())

    async def item_completed(self, item: dict) -> None:
        await self.emit("item/completed", item=item, completedAtMs=_now_ms())

    async def request_approval(self, method: str, params: dict) -> tuple[str, object]:
        """Ask the client (a server->client JSON-RPC request). Returns (decision name, raw decision)."""
        await self.trace("trace/approvalRequested", requestMethod=method, request=params)
        result = await self.session.request_client(method, params)
        # Exec/patch approvals answer {"decision": ...}; MCP elicitations answer {"action": ...}.
        raw = result.get("decision", result.get("action")) if isinstance(result, dict) else result
        # {"acceptWithExecpolicyAmendment": {"execpolicy_amendment": [...]}} is the one object-valued decision.
        name = raw if isinstance(raw, str) else next(iter(raw), "decline") if isinstance(raw, dict) else "decline"
        await self.trace("trace/approvalResolved", requestMethod=method, decision=name)
        return name, raw

    async def breakpoint(self, name: str, **info: Any) -> None:
        """Step mode: pause here until the client sends debug/continue."""
        await self.session.stepper.pause(self, name, info)


TURN_ABORTED_GUIDANCE = (
    "The user interrupted the previous turn on purpose. Any running unified exec processes may still be running "
    "in the background. If any tools/commands were aborted, they may have partially executed.")


def token_breakdown(usage: dict) -> dict:
    """Responses API usage -> Codex's camelCase TokenUsageBreakdown."""
    return {
        "totalTokens": usage.get("total_tokens", 0),
        "inputTokens": usage.get("input_tokens", 0),
        "cachedInputTokens": (usage.get("input_tokens_details") or {}).get("cached_tokens", 0),
        "cacheWriteInputTokens": (usage.get("input_tokens_details") or {}).get("cache_write_tokens", 0) or 0,
        "outputTokens": usage.get("output_tokens", 0),
        "reasoningOutputTokens": (usage.get("output_tokens_details") or {}).get("reasoning_tokens", 0),
    }


def _now_ms() -> int:
    return int(time.time() * 1000)


def new_turn() -> dict:
    """A Turn object in app-server v2 shape."""
    return {"id": str(uuid.uuid4()), "items": [], "status": "inProgress", "error": None,
            "startedAt": _now_ms(), "completedAt": None, "durationMs": None}


async def run_turn(session: "Session", text: str, turn: dict | None = None) -> dict:
    """Run one turn and return the Turn object."""
    turn = turn or new_turn()
    turn_id = turn["id"]
    ctx = TurnContext(session, turn_id)
    await session.bus.emit("turn/started", threadId=session.thread_id, turn={**turn, "items": []})
    session.rollout.event("task_started", turn_id=turn_id)

    stop_hook_active = False
    try:
        text = await hooks.run_user_prompt_submit(ctx, text)
        # Pre-turn compaction: already over the limit before this turn's input (turn.rs run_pre_sampling_compact).
        if session.history.token_count() >= session.model_info.effective_auto_compact_limit():
            await compact.run_compact(ctx, reason="pre-turn")
        await record_context_updates(ctx)
        session.rollout.turn_context(turn_id, session.config)
        user_item = {"type": "userMessage", "id": str(uuid.uuid4()), "content": [{"type": "text", "text": text}]}
        await ctx.item_started(user_item)
        await session.record(user_message(text))
        await ctx.item_completed(user_item)
        session.rollout.event("user_message", message=text)

        while True:
            ctx.iteration += 1
            needs_follow_up = await run_sampling_request(ctx)
            tokens = session.history.token_count()
            limit = session.model_info.effective_auto_compact_limit()
            await ctx.trace("trace/loopIteration", needsFollowUp=needs_follow_up, tokens=tokens,
                            autoCompactLimit=limit, contextWindow=session.model_info.context_window,
                            decision="continue" if needs_follow_up else "stop")
            if needs_follow_up and tokens >= limit:
                await compact.run_compact(ctx, reason="auto")
                continue
            if needs_follow_up:
                continue
            if continuation := await hooks.run_stop(ctx, stop_hook_active):
                stop_hook_active = True
                await session.record(user_message(continuation))
                continue
            break
        turn["status"] = "completed"
    except (asyncio.CancelledError, TurnAborted):
        turn["status"] = "interrupted"
        # Tell the model next time that this turn was cut short (core/src/context/turn_aborted.rs).
        await session.record(user_message(f"<turn_aborted>\n{TURN_ABORTED_GUIDANCE}\n</turn_aborted>"))
        session.rollout.event("turn_aborted", turn_id=turn_id, reason="interrupted")
    except hooks.HookBlocked as err:
        turn["status"] = "completed"  # Codex ends the turn quietly when a UserPromptSubmit hook blocks
        await session.bus.emit("warning", threadId=session.thread_id, turnId=turn_id, message=f"prompt blocked by hook: {err}")
    except Exception as err:  # surfaced to the client, like Codex's Error event
        turn["status"] = "failed"
        turn["error"] = {"message": str(err)}
        await session.bus.emit("error", threadId=session.thread_id, turnId=turn_id, error={"message": str(err)})
    turn["completedAt"] = _now_ms()
    turn["durationMs"] = turn["completedAt"] - turn["startedAt"]
    if turn["status"] != "interrupted":
        session.rollout.event("task_complete", turn_id=turn_id)
    await session.bus.emit("turn/completed", threadId=session.thread_id, turn=turn)
    return turn


async def record_context_updates(ctx: TurnContext) -> None:
    """Append only the context fragments that changed (all of them on the first turn)."""
    session = ctx.session
    fragments = world_state.build_fragments(session.config)
    changed = world_state.diff(session.context_snapshot, fragments)
    await ctx.trace("trace/promptAssembled",
                    baseInstructions={"source": session.base_instructions_source, "chars": len(session.base_instructions),
                                      "tokens": (len(session.base_instructions) + 3) // 4},
                    fragments=[{"kind": f.kind, "role": f.role, "source": f.source, "text": f.text,
                                "tokens": (len(f.text) + 3) // 4, "changed": f in changed} for f in fragments],
                    firstTurn=session.context_snapshot is None)
    session.context_snapshot = world_state.snapshot(fragments)
    if changed:
        await session.record(*world_state.to_messages(changed))


async def run_sampling_request(ctx: TurnContext) -> bool:
    """One model call. Returns True if the model asked for tools (so we must call it again)."""
    session = ctx.session
    prompt = Prompt(
        input=session.history.for_prompt(),
        tools=session.router.specs(),
        base_instructions=session.base_instructions,
        parallel_tool_calls=session.model_info.supports_parallel_tool_calls,
    )
    body = session.client.build_request(prompt)
    await ctx.breakpoint("beforeModelRequest", inputItems=len(body["input"]), tools=len(body["tools"]))
    await ctx.trace("trace/modelRequest", url=f"{session.config.base_url}/responses", body=body,
                    inputTokensEstimate=sum(approx_tokens(i) for i in body["input"]))

    tool_calls: list[ResponseItem] = []
    usage: dict | None = None
    end_turn_false = False
    started = time.monotonic()
    event_counts: dict[str, int] = {}
    output_items: list[ResponseItem] = []
    async for event in session.client.stream(body):
        event_counts[event.type] = event_counts.get(event.type, 0) + 1
        if session.trace_sse:
            await ctx.trace("trace/sseEvent", event=event.data)
        data = event.data
        if event.type == "response.output_item.added":
            await _item_added(ctx, data["item"])
        elif event.type == "response.output_text.delta":
            await ctx.emit("item/agentMessage/delta", itemId=data.get("item_id"), delta=data.get("delta", ""))
        elif event.type == "response.reasoning_summary_text.delta":
            await ctx.emit("item/reasoning/summaryTextDelta", itemId=data.get("item_id"),
                           summaryIndex=data.get("summary_index", 0), delta=data.get("delta", ""))
        elif event.type == "response.output_item.done":
            item = clean_output_item(data["item"])
            output_items.append(item)
            await session.record(item)
            if is_tool_call(item):
                tool_calls.append(item)
            else:
                await _item_done(ctx, item)
        elif event.type == "response.completed":
            usage = data.get("response", {}).get("usage")
            if data.get("response", {}).get("end_turn") is False:  # the server asks us to keep going (turn.rs)
                end_turn_false = True

    session.history.set_usage(usage)
    cost = None
    if usage:  # educodex extension: what this request cost and how much the prompt cache saved
        pricing = await session.ensure_pricing()
        cost = cost_breakdown(usage, pricing)
        session.total_cost = add_totals(session.total_cost, cost)
    await ctx.trace("trace/modelResponse", usage=usage, eventCounts=event_counts, outputItems=output_items,
                    seconds=round(time.monotonic() - started, 3), cost=cost)
    if cost:
        await ctx.trace("trace/cost", last=cost, total=session.total_cost,
                        inputItems=len(body["input"]), toolsTokens=approx_tokens({"tools": body["tools"]}))
    if usage:
        last = token_breakdown(usage)
        total = session.total_usage = {k: session.total_usage.get(k, 0) + v for k, v in last.items()}
        await ctx.emit("thread/tokenUsage/updated", tokenUsage={  # v2 ThreadTokenUsage (thread.rs)
            "total": total, "last": last, "modelContextWindow": session.model_info.context_window})
        session.rollout.event("token_count", info=usage)

    if tool_calls:
        outputs = await run_tool_calls(ctx, tool_calls)
        await session.record(*outputs)
    return bool(tool_calls) or end_turn_false


async def run_tool_calls(ctx: TurnContext, calls: list[ResponseItem]) -> list[ResponseItem]:
    """Run tool calls, keeping their order. Parallel-safe tools overlap; others take a lock.

    Mirrors codex-rs/core/src/tools/parallel.rs: parallel-safe tools share a read lock, the others
    take the write lock, so a serial tool never overlaps anything. A TaskGroup cancels the
    remaining calls if one of them aborts the turn.
    """
    session = ctx.session
    lock = ReadWriteLock()

    async def run_one(item: ResponseItem) -> ResponseItem:
        call = ToolCall.from_item(item)
        handler = session.router.get(call.name)
        await ctx.breakpoint("beforeToolCall", tool=call.name, callId=call.call_id)
        await ctx.trace("trace/toolDispatch", tool=call.name, callId=call.call_id, kind=item["type"],
                        arguments=call.arguments or None, input=call.input or None,
                        parallel=bool(handler and handler.supports_parallel))
        hooked = call.name != "write_stdin"  # Codex does not run tool hooks for write_stdin
        if hooked and (blocked := await hooks.run_pre_tool_use(ctx, call)):
            output = blocked
        else:
            async with lock.read() if handler and handler.supports_parallel else lock.write():
                output = await session.router.dispatch(call, ctx)
            if hooked:
                output = await hooks.run_post_tool_use(ctx, call, output)
        await ctx.trace("trace/toolOutput", tool=call.name, callId=call.call_id, output=output,
                        tokens=(len(output.encode()) + 3) // 4)
        await ctx.breakpoint("afterToolCall", tool=call.name, callId=call.call_id)
        return tool_output(item, output)

    try:
        async with asyncio.TaskGroup() as group:
            tasks = [group.create_task(run_one(c)) for c in calls]
    except* TurnAborted as aborted:
        raise aborted.exceptions[0] from None
    return [t.result() for t in tasks]


class ReadWriteLock:
    """Many readers or one writer (tokio's RwLock in Codex). Small enough to read in one go."""

    def __init__(self) -> None:
        self._readers = 0
        self._cond = asyncio.Condition()
        self._writing = False

    @contextlib.asynccontextmanager
    async def read(self):
        async with self._cond:
            await self._cond.wait_for(lambda: not self._writing)
            self._readers += 1
        try:
            yield
        finally:
            async with self._cond:
                self._readers -= 1
                self._cond.notify_all()

    @contextlib.asynccontextmanager
    async def write(self):
        async with self._cond:
            await self._cond.wait_for(lambda: not self._writing and self._readers == 0)
            self._writing = True
        try:
            yield
        finally:
            async with self._cond:
                self._writing = False
                self._cond.notify_all()


async def _item_added(ctx: TurnContext, item: ResponseItem) -> None:
    if item.get("type") == "message":
        await ctx.item_started({"type": "agentMessage", "id": item.get("id"), "text": ""})
    elif item.get("type") == "reasoning":
        await ctx.item_started({"type": "reasoning", "id": item.get("id"), "summary": [], "content": []})


async def _item_done(ctx: TurnContext, item: ResponseItem) -> None:
    if item.get("type") == "message":
        text = message_text(item)
        await ctx.item_completed({"type": "agentMessage", "id": item.get("id"), "text": text})
        ctx.session.rollout.event("agent_message", message=text)
    elif item.get("type") == "reasoning":
        summary = [s.get("text", "") for s in item.get("summary", [])]
        await ctx.item_completed({"type": "reasoning", "id": item.get("id"), "summary": summary, "content": []})

