# Refactor: split the Codex core from educodex's observability

**Goal:** `src/educodex/core/` contains only the harness, as close to Codex as possible. Everything educodex adds for teaching (trace events, pricing/cost, step mode) lives in `src/educodex/observe/`. They meet at one seam, a `Probe`, called from the core with one line per point. Codex has the same kind of seam: its OpenTelemetry calls such as `otel.sandbox_outcome(...)` sit at roughly the same places.

**Hard rule:** behaviour and the wire contract don't change. Every client (web UI, TUI, CLI) must receive the same `trace/*` notifications, with the same method names and the same param keys, at the same moments.

## Target layout

```
src/educodex/
  core/                 the harness (moved here unchanged except for the probe calls)
    __init__.py
    probe.py            NEW: the Probe interface (no-op base class)
    client.py config.py models.py items.py history.py events.py
    session.py turn.py compact.py rollout.py hooks.py
    context/  tools/  policy/  sandbox/  mcp/
  observe/              educodex-only additions
    __init__.py
    tracer.py           NEW: Tracer(Probe) -> emits today's trace/* events on the session's EventBus
    pricing.py          moved from educodex/pricing.py (unchanged logic)
    stepper.py          moved from educodex/stepper.py
  vendor/               unchanged (Codex data files; sync_vendor.py keeps writing here)
  testing/              unchanged (fake model)
  app_server/  cli.py  tui.py   hosts: build Session(..., probe=Tracer(...)) and wire them together
```

- Update every import in the package, the tests, `scripts/` and `examples/`.
- Leave no compatibility shims in the old locations.
- `python -m educodex.cli` and the `educodex` entry point keep working.

## The Probe (core/probe.py)

A plain class whose async methods all do nothing. The core calls `await <probe>.<method>(...)` and never formats trace payloads itself. Suggested methods (adjust names if clearer, keep the count small):

| Probe method | Called from (today's code) | Tracer emits |
|---|---|---|
| `thread_started(session)` | `Session.start` after tools are built | `trace/toolsRegistered` (incl. MCP summary and the `codexToolModeNote`); fetches pricing and emits `trace/pricing` |
| `mcp_server_listed(session, server, server_info, tools, spec)` / `mcp_server_failed(session, server, error)` | `mcp/manager.py` | `trace/mcpToolsListed` + `trace/mcpToolExposed` / `trace/mcpServerFailed` |
| `context_built(ctx, fragments, changed, first_turn)` | `turn.record_context_updates` | `trace/promptAssembled` (the Tracer reads base-instruction info from `ctx.session`) |
| `history_appended(session, items)` | `Session.record` | `trace/historyChanged` |
| `checkpoint(ctx, name, **info)` | the three current `ctx.breakpoint(...)` sites | Stepper: `trace/paused` / `trace/resumed` and waits |
| `model_request(ctx, body)` | `run_sampling_request` | `trace/modelRequest` |
| `sse_event(ctx, data)` | stream loop | `trace/streamEvent` (only if the Tracer's `trace_sse` option is on) |
| `model_response(ctx, body, output_items, usage, event_counts, seconds)` | after the stream | `trace/modelResponse` (with `cost`) and `trace/cost`. Cost totals and pricing state live in the Tracer, not the Session |
| `loop_iteration(ctx, needs_follow_up, tokens, limit, context_window)` | turn loop | `trace/loopIteration` |
| `tool_call(ctx, call, item, parallel)` / `tool_output(ctx, call, output)` | `run_tool_calls` | `trace/toolDispatch` / `trace/toolOutput` |
| `policy_decision(ctx, tool, decision, **details)` | `tools/handlers.py` (exec and patch), `mcp/manager.py` | `trace/policyDecision` |
| `sandbox_command(ctx, argv, policy, params, warning=None)` / `sandbox_denied(ctx, command, exit_code)` | `tools/handlers.py` | `trace/sandboxCommand` / `trace/sandboxDenied` |
| `approval_requested(ctx, method, params)` / `approval_resolved(ctx, method, decision)` | `TurnContext.request_approval` | `trace/approvalRequested` / `trace/approvalResolved` |
| `hook_ran(ctx, event, command, exit_code, stdout, stderr)` | `hooks.py` | `trace/hook` |
| `compaction_requested(ctx, reason, body, tokens_before)` / `compacted(ctx, ...)` | `compact.py` | `trace/compactionRequest` / `trace/compacted` |

**Everything that comes from the probe** (all names are as they exist today):
- **Session no longer holds** `stepper`, `pricing`, `total_cost`, `trace_sse` or `ensure_pricing()`. They belong to the Tracer.
- **TurnContext loses** `trace()` and `breakpoint()`.
- **The core may expose** a generic `ModelClient.list_models()` (GET `/models`; Codex's models-manager fetches a model list too). The Tracer parses pricing from it.

**Payload fidelity:**
- **Same keys as today:** each Tracer method must build exactly the params the current `ctx.trace(...)` / `bus.emit("trace/...")` call builds, including `threadId`, `turnId`, `iteration` and `_`-less keys.
- **Keep the event order:** e.g. `toolDispatch` stays before `policyDecision`.

**Hosts:**
- **Who passes the probe:** `cli.py`, `app_server/processor.py` and `tui.py` (via the app server) create a `Tracer()` and pass it as `Session(..., probe=tracer)`; the Tracer emits on the session's bus. A `Session` without a probe works and emits only protocol events.
- **Processor `debug/*` methods:** `stepMode/set` and `continue` act on the session's Tracer stepper. `traceSse` sets the Tracer option. Keep the processor's method shapes unchanged.
- **Interrupts:** `Session.interrupt` currently calls `stepper.release()`. Instead, call the probe (e.g. `await probe.turn_interrupted(ctx)`), or let the Tracer release its stepper when it sees cancellation. Either way, a paused step-mode turn must still be interruptible.

## What stays in the core

- **Protocol events:** `thread/started`, `turn/started|completed`, `item/*`, `turn/plan/updated`, `thread/tokenUsage/updated`, `thread/compacted`, `error`, `warning`. These mirror Codex's `EventMsg` / app-server notifications.
- **Codex's own behaviour:** approvals, policy, sandbox, hooks and compaction logic, unchanged.

## Acceptance

1. **Tests stay green.** `uv run --group dev pytest -q` passes; update test imports, and have tests that read `trace/*` events construct sessions with a `Tracer`. `cd web && pnpm test:e2e` passes.
2. **No reverse imports.** A new test, `tests/test_layers.py`, parses every module under `educodex/core/` with `ast` and fails if it imports `educodex.observe`, `educodex.app_server`, `educodex.cli` or `educodex.tui`.
3. **No inline trace payloads in the core.** `grep -rn '"trace/' src/educodex/core` finds nothing: all trace method names live in `observe/`.
4. **Same CLI output.** A fake-model run of `uv run educodex exec -v --fake-model examples/fake/demo.json --cwd <tmp> "x"` prints the same trace timeline as before.
5. **Readable docstrings.** Each core module keeps its "Mirrors codex-rs/..." line. `core/probe.py` explains in up to 5 lines that this is the observability seam and that Codex instruments the same places with OpenTelemetry.
