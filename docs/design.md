# educodex — design

An educational Python re-implementation of the [OpenAI Codex](https://github.com/openai/codex) harness. Every step that production harnesses hide (prompt assembly, tool exposure, policy decisions, the raw model request) is emitted as an event and shown in a web UI.

**Reference Codex commit:** `1c7c43cd85` (2026-10-07). Every module names the Codex file it mirrors.

The code lives in `backends/educodex/` of the eduagent repo; paths below are relative to it. The web UI is `visualiser/` at the repo root.

## Goals and non-goals

**Goals**
- Mirror Codex's architecture, names and wire formats closely enough that reading educodex explains Codex.
- Make every hidden step visible: the exact `input` array, each tool spec, every policy decision.
- Be readable in a meetup talk: small modules, plain asyncio, no clever abstractions.

**Non-goals**
- Performance: WebSocket transport to the model, prewarm, `previous_response_id`, smart retries.
- Non-OpenAI models (for now). We use OpenAI models through OpenRouter's Responses API.
- Codex product features: cloud tasks, realtime voice, multi-agent, plugins/apps, code mode, review mode, auto-review, Windows/Linux sandboxes, telemetry.

## Decisions

| Decision | Choice |
|---|---|
| Language | Python 3.12+, asyncio, `uv`. Web UI in React + TypeScript |
| Model access | OpenRouter Responses API (`/api/v1/responses`), stateless, OpenAI models only |
| Default model | `openai/gpt-6-luna` |
| Codex files | Copied into `src/educodex/vendor/codex/` by `scripts/sync_vendor.py`, with the source SHA recorded in `SOURCE.md` |
| `exec_command` | Long-lived sessions over plain pipes (Codex's `tty: false` mode) plus `write_stdin`. No PTY |
| Protocol | Codex app-server v2 method names over JSON-RPC lite, plus `trace/*` notifications and `debug/*` requests |

## Verified assumptions (`spikes/probe_openrouter.py`)

With `openai/gpt-6-luna` on OpenRouter:
- **Freeform `apply_patch`** (`type: "custom"` plus Codex's Lark grammar) round-trips via `custom_tool_call` and `custom_tool_call_output`.
- **`namespace` tools** (how Codex exposes MCP servers) work. The model calls `{"name": "get_forecast", "namespace": "mcp__weather"}`.
- **`store: false` + `include: ["reasoning.encrypted_content"]`** works, and reasoning items can be sent back.
- **Base instructions** sent as the first `developer` message work (the 18k-character Codex prompt).
- **Streaming** uses standard Responses SSE events.

## Architecture

```
┌────────────┐ ┌─────────────┐ ┌─────────┐
│ React web  │ │ Textual TUI │ │ CLI     │   clients
└─────┬──────┘ └──────┬──────┘ └─────┬───┘
      │ WebSocket     │ stdio (JSONL)│ in-process
┌─────┴───────────────┴──────┐       │
│ app_server                 │       │       JSON-RPC lite; maps core events → notifications
└─────────────┬──────────────┘       │
              │                      │       hosts build Session(..., probe=Tracer())
┌─────────────┴──────────────────────┴───┐
│ core                                   │          ┌───────────────────┐
│   session · turn · context · tools     │  probe   │ observe           │
│   policy · sandbox · compact · rollout ├─────────►│   tracer          │
│   hooks                                │          │   pricing         │
│ ┌──────────────┐ ┌───────────────────┐ │          │   stepper         │
│ │ client       │ │ mcp               │ │          └───────────────────┘
│ └──────────────┘ └───────────────────┘ │          trace/* events on the
└────────────────────────────────────────┘          session's EventBus
  client: Responses API over httpx/SSE · mcp: MCP servers over stdio
```

`core` never imports `observe`, `app_server` or the CLI/TUI (`tests/test_layers.py` checks this). A session publishes protocol events on an `EventBus`, and asks its host one question at a time (approvals) through a callback. This mirrors the split between Codex's `core` and `app-server`.

Everything educodex adds for teaching lives in `observe/`. The core calls a `Probe` (`core/probe.py`) with one line at each interesting point; the base class does nothing. Hosts pass `Session(..., probe=Tracer())`, and the `Tracer` turns those calls into `trace/*` events on the session's bus, runs step mode and tracks costs. Codex instruments the same places with OpenTelemetry (`codex-rs/otel/`).

## Module layout

| educodex module | Responsibility | Mirrors in `codex-rs/` |
|---|---|---|
| `core/client.py` | Build the request body, POST `/responses`, parse SSE | `core/src/client.rs`, `codex-api/src/common.rs`, `codex-api/src/sse/` |
| `core/models.py` | Model catalog (vendored `models.json`) | `models-manager/`, `protocol/src/openai_models.rs` |
| `core/items.py` | Response items as plain dicts in wire shape | `protocol/src/models.rs` |
| `core/history.py` | History, `normalize`, token counting | `core/src/context_manager/` |
| `core/context/` | Fragments: permissions, collaboration mode, AGENTS.md, environment; world-state diffs | `core/src/context/`, `core/src/session/world_state.rs`, `prompts/` |
| `core/turn.py` | The agentic loop, tool execution with a read/write lock | `core/src/session/turn.rs`, `core/src/stream_events_utils.rs`, `core/src/tools/parallel.rs` |
| `core/session.py` | One thread: history, client, tools | `core/src/session/session.rs`, `thread_manager.rs` |
| `core/probe.py` | No-op observability hooks the core calls | `otel/` (`SessionTelemetry`) |
| `core/tools/specs.py` | Tool JSON exactly as Codex sends it | `core/src/tools/handlers/*_spec.rs` |
| `core/tools/handlers.py`, `registry.py` | Policy → approval → (sandboxed) run → output | `core/src/tools/{handlers,registry.rs,router.rs,orchestrator.rs}` |
| `core/tools/processes.py` | `exec_command` sessions and `write_stdin` | `core/src/unified_exec/` |
| `core/tools/apply_patch.py` | Parse and apply Codex patches | `apply-patch/` |
| `core/tools/output.py` | Output format and middle truncation | `core/src/tools/context.rs`, `utils/string/src/truncate.rs` |
| `core/policy/` | Segments, dangerous commands, prefix rules, decisions | `core/src/exec_policy.rs`, `core/src/safety.rs`, `shell-command/`, `execpolicy/` |
| `core/sandbox/seatbelt.py` | `sandbox-exec` with Codex's `.sbpl` files | `sandboxing/src/seatbelt.rs` |
| `core/mcp/` | MCP client, naming, schema clean-up, approvals | `codex-mcp/`, `core/src/tools/handlers/mcp.rs`, `core/src/mcp_tool_call.rs`, `tools/src/json_schema.rs` |
| `core/compact.py` | Local compaction | `core/src/compact.rs` |
| `core/rollout.py` | JSONL session log | `rollout/src/recorder.rs` |
| `core/hooks.py` | PreToolUse / PostToolUse / UserPromptSubmit / Stop | `hooks/`, `core/src/hook_runtime.rs` |
| `core/skills/` | Skill roots and scan, bundled skills, the catalog, `$name` injection | `skills/`, `ext/skills/` |
| `core/memories/` | Read path, citations, `/memory-update` (phase 1 + phase-2 sub-agent), `/memory-drop` | `memories/`, `ext/memories/`, `state/` (memories tables) |
| `observe/tracer.py` | `trace/*` events (a `Probe` subclass) | – (educodex only) |
| `observe/pricing.py`, `observe/stepper.py` | Request costs; step mode | – (educodex only) |
| `app_server/` | JSON-RPC lite over WebSocket and stdio | `app-server/`, `app-server-protocol/`, `app-server-transport/` |
| `testing/fake_model.py` | Scripted Responses SSE for tests and offline demos | – |
| `cli.py`, `tui.py` | Terminal clients | `cli/`, `tui/` |

## Core flow

### 1. Prompt assembly
At the start of a thread (layout from Codex's `model_visible_layout` snapshots):

```
[0] developer  base instructions        ← models.json model_messages.instructions_template (added by client.py, not stored in history)
[1] developer  [developer_instructions] [## Memory…] [<skills_instructions>…] <permissions instructions>…  <collaboration_mode>…
[2] user       # AGENTS.md instructions for {cwd} <INSTRUCTIONS>…</INSTRUCTIONS>   <environment_context>…
[3] user       the user's message
[4] user       <skill>…</skill>, one per skill the user named with $name
```

On later turns, only fragments whose text changed are appended as new messages. Earlier messages never change, so each request is an exact prefix of the next and the prompt cache keeps hitting.

### 2. Model request
```json
{ "model": "openai/gpt-6-luna", "input": [...], "tools": [...], "tool_choice": "auto",
  "parallel_tool_calls": true, "reasoning": {"effort": "medium", "summary": "auto"},
  "store": false, "stream": true, "include": ["reasoning.encrypted_content"],
  "prompt_cache_key": "<thread id>", "text": {"verbosity": "low"} }
```

### 3. The loop
1. Stream the reply and record each output item.
2. If there were tool calls, run them and record their outputs.
3. If the context is over the auto-compact limit, compact.
4. Repeat until the model stops calling tools.

Tools that can run in parallel share a read lock; the rest take the write lock, as in Codex's `parallel.rs`. An interrupt records `<turn_aborted>` so the next turn knows the previous one was cut short.

### 4. Guardrails
- **Approval policy:** `on-request` or `never`. **Sandbox:** `read-only`, `workspace-write` or `danger-full-access`.
- **Decisions are made per command segment** (`a && b | c`), and the strictest wins.
  - A segment either matches a prefix rule, or gets the heuristics: forced `rm` is dangerous, escalation needs a prompt, and everything else runs in the sandbox.
  - Commands with `$(…)`, backticks, redirections, subshells or newlines never match an allow rule.
- **Approval does not remove the sandbox.** Only an approved `require_escalated` runs unsandboxed.
- **Patches** inside writable roots are auto-approved, except under `.git`, `.codex` or `.agents`.
- **Seatbelt** allows reads everywhere and writes under `cwd`, `/tmp` and `$TMPDIR`, minus the protected folders. Network is off unless `--network` is passed.

### 5. MCP
- **Exposure:** each server becomes one `namespace` tool, `mcp__<server>`, with sanitised (and, when names collide, hashed) tool names and cleaned schemas.
- **Approvals** come from the tool annotations and are requested through `mcpServer/elicitation/request`.
- **Results:** the model receives `structuredContent` if present, otherwise the text content.
- **No sandbox:** MCP servers run outside the sandbox, as in Codex.

### 6. Compaction
- **Trigger:** tokens reach min(model limit, 90% of the context window), counted as API usage plus estimates for newer items. It is checked before a turn and between iterations, and can also be run manually.
- **New history:** the recent user messages (up to 20k tokens), then fresh context inserted before the last of them, then Codex's summary prefix with the summary.

## App-server protocol

JSON-RPC lite: JSON-RPC shapes without `"jsonrpc": "2.0"`, sent as JSONL over stdio or as one message per WebSocket frame. The WebSocket only accepts loopback origins.

| Kind | Codex v2 methods (same names) |
|---|---|
| Client → server | `initialize` (+ `initialized`), `thread/start`, `thread/list`, `thread/read`, `turn/start`, `turn/interrupt`, `thread/compact/start`, `model/list`, `skills/list`, `memory/reset` |
| Notifications | `thread/started`, `turn/started`, `turn/completed`, `item/started`, `item/completed`, `item/agentMessage/delta`, `item/reasoning/summaryTextDelta`, `item/commandExecution/outputDelta`, `item/commandExecution/terminalInteraction`, `turn/plan/updated`, `thread/tokenUsage/updated`, `thread/compacted`, `error`, `warning` |
| Server → client requests | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` (decisions `accept`, `acceptForSession`, `acceptWithExecpolicyAmendment`, `decline`, `cancel`), `mcpServer/elicitation/request` (`accept`, `decline`, `cancel`) |

`turn/start` takes `sandboxPolicy: {"type": "readOnly" | "workspaceWrite" | "dangerFullAccess"}`, as in Codex. `thread/start` takes the kebab-case mode.

**educodex extensions:**
- `trace/*` notifications: `promptAssembled`, `toolsRegistered`, `modelRequest`, `modelResponse`, `sseEvent` (opt-in), `loopIteration`, `toolDispatch`, `toolOutput`, `policyDecision`, `sandboxCommand`, `sandboxDenied`, `approvalRequested`/`Resolved`, `mcpToolsListed`, `mcpToolExposed`, `historyChanged`, `compactionRequest`, `compacted`, `hook`, `paused`/`resumed`.
- `trace/pricing` and `trace/cost`: prices from OpenRouter's `/models`, and each request's cost split into uncached input, cache reads, cache writes and output, with the savings from caching (`observe/pricing.py`). Codex reports tokens, not money.
- `debug/*` requests: `debug/stepMode/set`, `debug/continue`, `debug/context/get`.
- `memory/update/start`: run the memory write path now (Codex starts it on its own), with a `memoryUpdate` item and `trace/memory*` events. Also `trace/skillsLoaded` and `trace/skillInjected`.
- Notifications carry `_seq` and `_ts` so the timeline can be ordered and timed.

Clients can opt out of any notification with Codex's `optOutNotificationMethods`.

## Deliberate simplifications (all are noted in the code)

- **Tool timing:** tools start after the response stream ends. Codex starts them while it is still streaming.
- **Context diffs** are made per whole fragment. Codex diffs environment fields one by one, and adds a notice when AGENTS.md is replaced.
- **Context updates are checked at turn start**, not before every sampling step.
- **`exec_command`:**
  - It never allocates a PTY; the `tty` parameter is accepted and ignored. The spec text is still Codex's own ("Runs a command in a PTY…").
  - It keeps the newest 1 MiB of output, where Codex keeps the head and tail.
  - It returns an error at the 64-process limit, where Codex prunes the oldest process.
- **`apply_patch`:** no heredoc-lenient parsing, and no interception of `apply_patch` typed inside `exec_command`.
- **Compaction is local only.** Codex prefers remote compaction: a normal `/responses` request ending in a `compaction_trigger` item, answered with one encrypted `compaction` item. It also force-compacts at 95% of the window.
- **Classic tool calling for every model.** The catalog marks most current models (including `gpt-6-luna`) `tool_mode: code_mode_only` and `use_responses_lite: true`. Codex then exposes a single JavaScript `exec` tool, sends the tool list as an `additional_tools` input item, and sets `parallel_tool_calls: false`. educodex always uses classic `tools`, as Codex does for `gpt-5.5`. The trace says this for each model.
- **Reasoning summaries:** educodex asks for `reasoning.summary: "auto"` so you can see them. Codex uses the model's default, which is `"none"`.
- **No OS sandbox outside macOS.** There, commands that would be sandboxed need approval under `on-request`.
- **Rollout:** `token_count` stores the raw API usage.
- **Hooks** only run shell commands.
- **Skills:** no catalog budget, no per-skill enable/disable, no `agents/openai.yaml`, no plugin/admin/cloud roots (chapter 14).
- **Memories:** run on `/memory-update`, not on every turn; a JSON file instead of SQLite job tables, leases and retries; no usage ranking (chapter 17).

## Documentation

`docs/guide/educodex/` is a step-by-step guide from basics to advanced ([outline](guide/educodex/README.md)). Each chapter covers the concept, the educodex code, the Codex code (permalinks at the pinned commit), where educodex is simpler, things to try, and further reading.

## Milestones

| # | Milestone | Status |
|---|---|---|
| 0 | Spike: OpenRouter compatibility | ✅ |
| 1 | Core loop, prompt, tools, CLI with trace output | ✅ |
| 2 | App server (WebSocket + stdio), session log, step mode | ✅ |
| 3 | Web UI | ✅ |
| 4 | Guardrails: approvals, rules, dangerous commands, Seatbelt | ✅ |
| 5 | MCP (demo server `examples/mcp/notes_server.py`) | ✅ |
| 6 | Compaction, hooks, `write_stdin` sessions | ✅ |
| 7 | TUI | ✅ |
| 8 | Skills: roots, catalog, `$name` injection, bundled `skill-creator`, `/` and `$` lists in the clients | ✅ |
| 9 | Memories (Codex v1): read path, citations, `/memory-update`, `/memory-drop` | ✅ |
