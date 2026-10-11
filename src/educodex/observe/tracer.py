"""Tracer: a Probe that turns the core's probe calls into educodex's trace/* events.

Codex has no such events; they show the steps a production harness hides (prompt assembly, raw
requests, policy decisions, sandbox argv, costs). The Tracer also owns step mode and pricing.
Use one Tracer per Session: it keeps per-request state, and a session runs one request at a time.
"""

import time
from typing import TYPE_CHECKING, Any

from educodex.core.items import ResponseItem, approx_tokens, clean_output_item
from educodex.core.probe import Probe
from educodex.observe.pricing import Pricing, add_totals, cost_breakdown, pricing_from_models
from educodex.observe.stepper import Stepper

if TYPE_CHECKING:
    from educodex.core.session import Session
    from educodex.core.turn import TurnContext


class Tracer(Probe):
    def __init__(self, trace_sse: bool = False) -> None:
        self.trace_sse = trace_sse  # opt-in: one trace event per raw SSE event
        self.stepper = Stepper()
        self.pricing: Pricing | None = None  # fetched from the provider (OpenRouter /models)
        self.total_cost: dict = {}  # running cost totals (pricing.add_totals)
        self._pricing_for: str | None = None  # model we last fetched prices for
        # the current model request
        self._started = 0.0
        self._event_counts: dict[str, int] = {}
        self._output_items: list[ResponseItem] = []

    async def _thread(self, session: "Session", method: str, **params: Any) -> None:
        await session.bus.emit(method, threadId=session.thread_id, **params)

    async def _turn(self, ctx: "TurnContext", method: str, **params: Any) -> None:
        await ctx.session.bus.emit(method, threadId=ctx.thread_id, turnId=ctx.turn_id, iteration=ctx.iteration, **params)

    # --- session --------------------------------------------------------------------------
    async def thread_started(self, session: "Session") -> None:
        info, note = session.model_info, None
        if info.codex_tool_mode or info.codex_use_responses_lite:
            note = (f"Codex runs {info.slug} with tool_mode={info.codex_tool_mode}, "
                    f"use_responses_lite={info.codex_use_responses_lite}: one JavaScript `exec` tool, sent as an "
                    "`additional_tools` input item. educodex uses classic tool calling, as Codex does for gpt-5.5.")
        await self._thread(session, "trace/toolsRegistered", tools=session.router.specs(),
                           mcpServers=session.mcp.summary(), codexToolModeNote=note)
        await self._ensure_pricing(session)

    async def _ensure_pricing(self, session: "Session") -> Pricing | None:
        """Prices for the current model, fetched once (again after a model switch)."""
        model = session.config.model
        if self._pricing_for != model:
            self._pricing_for = model
            try:
                self.pricing = pricing_from_models(model, await session.client.list_models())
            except Exception as err:  # pricing is nice to have; never fail the session over it
                self.pricing = None
                await self._thread(session, "trace/pricing", model=model, pricing=None, error=str(err))
                return None
            await self._thread(session, "trace/pricing", model=model,
                               pricing=self.pricing.to_json() if self.pricing else None, source="GET /models")
        return self.pricing

    async def mcp_server_listed(self, session, server, server_info, tools, spec) -> None:
        await self._thread(session, "trace/mcpToolsListed", server=server, serverInfo=server_info, tools=tools)
        await self._thread(session, "trace/mcpToolExposed", server=server, spec=spec)

    async def mcp_server_failed(self, session, server, error) -> None:
        await self._thread(session, "trace/mcpServerFailed", server=server, error=error)

    async def history_appended(self, session, items) -> None:
        await self._thread(session, "trace/historyChanged", appended=items, totalItems=len(session.history.items),
                           tokens=session.history.token_count())

    # --- turn loop ------------------------------------------------------------------------
    async def context_built(self, ctx, fragments, changed, first_turn) -> None:
        session = ctx.session
        source = ("config.base_instructions" if session.config.base_instructions else
                  f"vendor/codex/models.json → {session.model_info.slug}.model_messages.instructions_template")
        base = session.base_instructions
        await self._turn(ctx, "trace/promptAssembled",
                         baseInstructions={"source": source, "chars": len(base), "tokens": (len(base) + 3) // 4},
                         fragments=[{"kind": f.kind, "role": f.role, "source": f.source, "text": f.text,
                                     "tokens": (len(f.text) + 3) // 4, "changed": f in changed} for f in fragments],
                         firstTurn=first_turn)

    async def checkpoint(self, ctx, name, **info) -> None:
        """Step mode: pause here until the client sends debug/continue."""
        if not self.stepper.should_pause(name):
            return
        if body := info.pop("body", None):  # beforeModelRequest: show sizes, not the whole request
            info = {"inputItems": len(body["input"]), "tools": len(body["tools"]), **info}
        await self._turn(ctx, "trace/paused", breakpoint=name, info=info)
        await self.stepper.wait()
        await self._turn(ctx, "trace/resumed", breakpoint=name)

    async def model_request(self, ctx, body) -> None:
        self._started, self._event_counts, self._output_items = time.monotonic(), {}, []
        await self._turn(ctx, "trace/modelRequest", url=f"{ctx.config.base_url}/responses", body=body,
                         inputTokensEstimate=sum(approx_tokens(i) for i in body["input"]))

    async def sse_event(self, ctx, event) -> None:
        self._event_counts[event.type] = self._event_counts.get(event.type, 0) + 1
        if event.type == "response.output_item.done":
            self._output_items.append(clean_output_item(event.data["item"]))
        if self.trace_sse:
            await self._turn(ctx, "trace/sseEvent", event=event.data)

    async def model_response(self, ctx, body, usage) -> None:
        cost = None
        if usage:  # what this request cost and how much the prompt cache saved
            cost = cost_breakdown(usage, await self._ensure_pricing(ctx.session))
            self.total_cost = add_totals(self.total_cost, cost)
        await self._turn(ctx, "trace/modelResponse", usage=usage, eventCounts=self._event_counts,
                         outputItems=self._output_items, seconds=round(time.monotonic() - self._started, 3), cost=cost)
        if cost:
            await self._turn(ctx, "trace/cost", last=cost, total=self.total_cost,
                             inputItems=len(body["input"]), toolsTokens=approx_tokens({"tools": body["tools"]}))

    async def loop_iteration(self, ctx, needs_follow_up, tokens, limit, context_window) -> None:
        await self._turn(ctx, "trace/loopIteration", needsFollowUp=needs_follow_up, tokens=tokens,
                         autoCompactLimit=limit, contextWindow=context_window,
                         decision="continue" if needs_follow_up else "stop")

    # --- tools, policy, sandbox, approvals, hooks -------------------------------------------
    async def tool_call(self, ctx, call, item, parallel) -> None:
        await self._turn(ctx, "trace/toolDispatch", tool=call.name, callId=call.call_id, kind=item["type"],
                         arguments=call.arguments or None, input=call.input or None, parallel=parallel)

    async def tool_output(self, ctx, call, output) -> None:
        await self._turn(ctx, "trace/toolOutput", tool=call.name, callId=call.call_id, output=output,
                         tokens=(len(output.encode()) + 3) // 4)

    async def policy_decision(self, ctx, tool, decision, sandboxed, reason, matched_rules, **target) -> None:
        await self._turn(ctx, "trace/policyDecision", tool=tool, **target, decision=decision, sandboxed=sandboxed,
                         reason=reason, matchedRules=matched_rules, approvalPolicy=ctx.config.approval_policy,
                         sandboxMode=ctx.config.sandbox_mode)

    async def sandbox_command(self, ctx, argv, policy, params, warning=None) -> None:
        if policy is not None:  # sandbox-exec -p <policy text> ...: show a placeholder, the policy has its own key
            argv = [*argv[:1], "-p", "<policy>", *argv[3:]]
        await self._turn(ctx, "trace/sandboxCommand", argv=argv, policy=policy, params=params,
                         **({"warning": warning} if warning else {}))

    async def sandbox_denied(self, ctx, command, exit_code) -> None:
        await self._turn(ctx, "trace/sandboxDenied", command=command, exitCode=exit_code,
                         note="The model sees the denial and may retry with sandbox_permissions=require_escalated.")

    async def approval_requested(self, ctx, method, params) -> None:
        await self._turn(ctx, "trace/approvalRequested", requestMethod=method, request=params)

    async def approval_resolved(self, ctx, method, decision) -> None:
        await self._turn(ctx, "trace/approvalResolved", requestMethod=method, decision=decision)

    async def hook_ran(self, ctx, event, command, exit_code, stdout, stderr) -> None:
        await self._turn(ctx, "trace/hook", event=event, command=command, exitCode=exit_code,
                         stdout=stdout[-2000:], stderr=stderr[-2000:])

    # --- compaction -----------------------------------------------------------------------
    async def compaction_requested(self, ctx, reason, body, tokens_before) -> None:
        await self._turn(ctx, "trace/compactionRequest", reason=reason, body=body, tokensBefore=tokens_before)

    async def compacted(self, ctx, reason, summary, items_before, tokens_before, new_history) -> None:
        await self._turn(ctx, "trace/compacted", reason=reason, summary=summary, itemsBefore=items_before,
                         itemsAfter=len(new_history), tokensBefore=tokens_before,
                         tokensAfter=ctx.session.history.token_count(), newHistory=new_history)
