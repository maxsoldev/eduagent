# eduagent protocol spec

Each backend speaks its harness's native protocol (ADR 0001). The visualiser has one **adapter** per protocol. The adapter maps native messages into one neutral **view model**, and the chat, the Inspector and the context bar read only that view model. This document is the contract between adapters and the rest of the visualiser.

Contents:

1. View model (the types every adapter produces)
2. View actions (how an adapter changes the view)
3. Adapter interface
4. Capabilities (which panels a backend entry shows)
5. Harness links (timeline source and guide links)
6. Trace events (shared vocabulary, payload shapes and fixtures)

Code: `visualiser/src/view/model.ts`, `visualiser/src/adapters/types.ts`, `visualiser/src/view/capabilities.ts`, `visualiser/src/view/harness.ts`. If this document and the code disagree, fix one of them.

## 1. View model

A `View` holds the state of one viewer:

| Field | Type | Meaning |
|---|---|---|
| `status` | `"connecting" \| "open" \| "closed"` | WebSocket state |
| `closedReason` | `string \| null` | why it closed, from the launcher's close reason (`"educodex exited with code 1"`) |
| `sessionId` | `string \| null` | the backend's session: Codex thread id, pi session id |
| `running` | `boolean` | a turn is running |
| `turns` | `Turn[]` | the conversation |
| `events` | `TimelineEvent[]` | every native event and trace event, in arrival order, for all sessions of this viewer |
| `wire` | `{direction: "in" \| "out", message, at}[]` | native messages, unchanged (Protocol tab) |
| `approvals` | `Approval[]` | open approval prompts (Codex only) |
| `paused` | `{breakpoint, info} \| null` | step mode: where the loop waits |
| `pricing`, `costs`, `costTotal` | trace payloads | from the `pricing` and `cost` trace events |
| `queue` | `{steering: string[], followUp: string[]} \| null` | messages waiting for the agent (pi's `queue_update`); `null` until one is seen. The viewer lists them above the composer |

A `Turn` is `{id: string | null, status: "running" | "completed" | "interrupted" | "failed" | null, durationMs?, entries: Entry[]}`. A turn with `id: null` holds entries outside any backend turn (slash-command notes, errors between turns). The chat draws a separator `turn <status> · <seconds>s` after each ended turn.

### Entries

Every entry has a unique `id`. An adapter sends the same id again to update the entry (for example when a streamed item completes).

| `kind` | Fields | Codex source | pi source |
|---|---|---|---|
| `user` | `text`, `skills: {name, path}[]` | `userMessage` item | user `message_start`/`message_end` (`skills` stays empty: pi expands `/skill:name` into the text) |
| `assistant` | `text`, `streaming`, `part?` | `agentMessage` item, `item/agentMessage/delta` | one entry per text block of an assistant message: `text_start`, `text_delta`, then `message_end` |
| `reasoning` | `summary: string[]`, `streaming` | `reasoning` item, `item/reasoning/summaryTextDelta` | one entry per thinking block: `thinking_start`, `thinking_delta` (into `summary[0]`), then `message_end` |
| `tool` | `name`, `toolKind: "shell" \| "mcp" \| "other"`, `title`, `arguments`, `output`, `status`, `exitCode?`, `error?`, `streaming`, `part?` | `commandExecution`, `fileChange`, `mcpToolCall` items | `tool_execution_start` / `_update` / `_end` |
| `compaction` | `streaming`, `reason?` | `contextCompaction` item | `compaction_start` / `compaction_end` (`reason`: manual, threshold, overflow). A `compaction_end` without `result` (failed or cancelled) turns the entry into a `notice` with pi's `errorMessage` |
| `notice` | `level: "info" \| "error"`, `source: "client" \| "backend"`, `text` | `error` notification; client notes | assistant `message_end` with `stopReason: "error"` (`errorMessage`), failed compaction. Error replies reject the command; the viewer shows them as client notes |
| `native` | `part`, `streaming` | `turn/plan/updated`, `memoryUpdate` item | (none yet) |

- `tool.status` is one of `running`, `completed`, `failed`, `declined`, `aborted`. Codex `inProgress` maps to `running`. pi: `isError` maps to `failed`. pi ends the tools it aborts with an error result, so when a run settles with `aborted: true`, the failed tools of the last assistant message become `aborted`.
- `tool.title` is the one-line summary in the card header: the command line for a shell tool, `server.tool` for MCP, the file list for a patch.
- `tool.toolKind` picks the generic card: `shell` (testid `command`, shows output and exit code), `mcp` (testid `mcp-call`), `other` (testid `tool-call`, shows arguments and output). pi's `bash` is `shell`; `read`, `edit`, `write` are `other`.
- `tool.output` is the text the user sees. Adapters join text content parts.

### Native parts (backend-only)

A `NativePart` is `{protocol, type, data}`. `data` has the native shape, and only that protocol's components know it. An entry with a `part` is drawn by the adapter's `NativeEntry` component instead of the generic one. Codex uses parts for:

| Entry | `part.type` | Drawn as |
|---|---|---|
| `native` | `plan` | the plan card (`data: {plan, explanation}`) |
| `native` | `memoryUpdate` | memory phase 1 and phase 2 |
| `tool` | `fileChange` | file list with diffs |
| `assistant` | `agentMessage` | the message and its memory citation (only when `memoryCitation` is set) |

pi uses one part:

| Entry | `part.type` | Drawn as |
|---|---|---|
| `tool` | `editDiff` | the edit tool's diff (`data: {path, diff, firstChangedLine}`; `diff` is pi's display diff from `result.details.diff` of `tool_execution_end`: `+NN`, `-NN`, ` NN` lines) |

An `Approval` is `{id, part}`: the native request id and the native request as a part. The adapter's `ApprovalCard` draws it and passes the native answer to `adapter.respond`.

### Timeline events

`TimelineEvent = {seq, ts, name, trace, sessionId?, data}`.

- `trace: true` for trace events. Their `name` is the shared name without a namespace: Codex `trace/modelRequest` and edupi `{type: "trace", name: "modelRequest"}` both become `modelRequest`.
- `trace: false` for native events. `name` is the native name: `turn/started` (Codex), `agent_start` (pi).
- `data` is the payload: Codex `params` without `_seq`/`_ts`; for pi, the message without `type` (and without `name` for trace messages) is a good choice.
- `seq` and `ts` (milliseconds): from the backend if it sends them (educodex `_seq`, `_ts` in seconds), else assigned on arrival.

## 2. View actions

Adapters change the view only through `ViewAction`s, folded by `reduceView(view, action)`:

| Action | Effect |
|---|---|
| `{type: "status", status, reason?}` | connection state; `reason` on close |
| `{type: "wire", direction, message}` | add a native message to the Protocol log |
| `{type: "session", id}` | new session: empty chat, keep events, wire and pricing |
| `{type: "turnStarted", id}` / `{type: "turnEnded", id, status, durationMs?}` | open / close a turn; ending clears approvals and `paused` |
| `{type: "entry", entry}` | add the entry to the open turn, or replace the entry with the same id |
| `{type: "append", id, field: "text" \| "output" \| "summary", delta, index?}` | stream text into an entry |
| `{type: "event", event}` | add a timeline event; the trace events `pricing`, `cost`, `paused`, `resumed` also update the view |
| `{type: "approval", approval}` / `{type: "approvalResolved", id}` | open / close an approval prompt |
| `{type: "notice", level, source, text}` | add a notice entry |

The mapping from native messages to actions is a pure function (Codex: `codexActions(message)` in `visualiser/src/adapters/codex/mapping.ts`). Adapter tests (seam C, vitest, `visualiser/test/`) replay a recorded stdout transcript through it and check the resulting `View`.

## 3. Adapter interface

An adapter module (`AdapterModule` in `visualiser/src/adapters/types.ts`) has:

- `protocol`: the protocol name in the launcher config (`codex-app-server`, `pi-rpc`). `visualiser/src/adapters/index.ts` maps protocol names to modules. The viewer picks the module from the backend list, so the native handshake does not change.
- `create({url, capabilities, dispatch})`: makes the client. It opens the WebSocket, sends native commands and dispatches view actions.
- `defaults`: initial values of the adapter's own settings (Codex: `approvalPolicy`, `sandbox`).
- Components: `NativeEntry`, `ApprovalCard`, and optional header `Controls`.

The client (`Adapter`) has: `connect()` (handshake, model list), `startSession(settings)`, `send(settings, text, skills)`, `interrupt()`, `compact()`, `listSkills(cwd)`, `runCommand(name)` for adapter-only slash commands, `setStepMode(enabled)`, `continueStep()`, `context()`, `respond(approval, result)`, `wireLabel(message)`, and the fields `explain` (timeline texts), `commands`, `efforts`, `protocolNote` and `contextTriggers`.

`context()` returns the next model request as a `ContextSnapshot`: `{items: ContextItem[], tools: {names, tokens}, contextWindow, autoCompactLimit}`. Each `ContextItem` is `{label, cat, tokens, preview, summary, parts, raw}`; `cat` is one of the context bar categories (`base`, `injected`, `user`, `assistant`, `reasoning`, `call`, `output`, `summary`, `other`). The Context tab asks again after each trace event named in `contextTriggers` (Codex: `historyChanged`).

### The pi adapter (`pi-rpc`)

pi's RPC protocol (`pi --mode rpc`, `packages/coding-agent/src/modes/rpc/` at the pinned commit) has no handshake and no ids on events, so `createPiMapping()` (`visualiser/src/adapters/pi/mapping.ts`) keeps a little state:

- **Session:** a `get_state` reply with a new `sessionId` gives a `session` action. The client sends `get_state` and `get_messages` on connect, and `new_session` then `get_state` for "new thread". Every timeline event gets the current session id.
- **History:** a `get_messages` reply fills an empty chat with the session so far (a backend started with `--continue` or `--session`): each user message starts a completed turn, and a tool call with its later `toolResult` becomes one tool entry. The first "new thread" after such a connect keeps that session.
- **Queues:** `queue_update` gives a `queue` action with both queues. With the `queues` capability the composer stays open while a turn runs: Enter or "steer" sends `steer`, Alt+Enter or "follow-up" sends `follow_up`, "abort" sends `abort`.
- **Turn:** the first `agent_start` opens a turn (`<session>-t<n>`); `agent_settled` ends it, `interrupted` if `aborted`, else `completed`. A retry inside one run (a second `agent_start` before `agent_settled`) stays in the same turn. `durationMs` runs from the first message's `timestamp` to the end of the last reply (`timestamp + durationMs`).
- **Entry ids:** messages are counted (`<session>-m<n>`); a text block is `<message>-c<contentIndex>`; a tool is its `toolCallId`; a compaction `<session>-k<n>`.
- **Replies** (`type: "response"`) are not timeline events; the client matches them by `id`.
- **Commands sent:** `get_state`, `get_messages`, `new_session`, `prompt`, `steer`, `follow_up`, `abort`, `compact`, `set_thinking_level`, `get_commands` (skills: `source: "skill"`, name `skill:<name>`). A prompt with a `$skill` becomes `/skill:<name> <text>`, which pi expands.
- **edupi's debug commands** (capabilities `stepMode` and `contextInspector`; real pi has neither and answers `Unknown command`): `debug_set_step_mode {enabled, breakpoints?}` → `{enabled, breakpoints}`, `debug_continue`, and `debug_get_context` → `{body, messageCount, tokens, contextWindow, autoCompactLimit}` (`body` is the exact next Chat Completions request). `context()` maps the reply with `piContext`; `contextTriggers` are `modelResponse`, `toolOutput`, `compacted`, `paused` and `promptAssembled`.

edupi speaks the same protocol, so the same adapter serves the `edupi` entries (Playwright: `visualiser/e2e/edupi.spec.ts`).

The wire types come from edupi, a workspace package of the visualiser: `visualiser/src/adapters/pi/protocol.ts` imports pi's `RpcCommand`, `RpcResponse`, `RpcSessionState` and `JsonAgentSessionEvent` from `@eduagent/edupi` (its `exports`: `rpc-types`, `json-event`, `ai-types`, `agent-types`). So `PiRpcClient.command(type, fields)` checks each command's fields and types its reply's `data`. The imports are type-only; nothing from edupi runs in the browser.

Seam C fixtures: `visualiser/test/fixtures/pi/` (`chat`, `abort`, `compact`, `queues`; `meta.json` has the pi commit), recorded by `visualiser/test/record-pi.mjs`.

## 4. Capabilities

Capabilities come only from the launcher config entry (`capabilities` in `launcher/backends*.json`, listed by `GET /backends`). Without a capability, the viewer hides its panels and does not send its settings:

| Capability | Shows |
|---|---|
| `approvals` | approval policy select, approval cards, Guardrails tab (with `trace`) |
| `sandbox` | sandbox select, Guardrails tab (with `trace`) |
| `memories` | `/memory-update`, `/memory-drop` |
| `skills` | `/skills` and the `$` skill popup |
| `compaction` | compact button and `/compact` |
| `stepMode` | step mode toggle |
| `trace` | Requests and Tools tabs, cost badge |
| `contextInspector` | Context tab |
| `mcp` | MCP servers in the Tools tab |
| `queues` | steer, follow-up and abort while a turn runs, and the queued messages (pi) |

Timeline and Protocol always show, because they also list native messages. The test entry `educodex-plain` in `launcher/backends.test.json` has no capabilities (`visualiser/e2e/view.spec.ts`).

## 5. Harness links

Timeline links come from the backend entry's `harness` (`visualiser/src/view/harness.ts`):

| Harness | Source base (pinned commit) | Guide section |
|---|---|---|
| `Codex` | `https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/` | `/guide/educodex/<chapter>` |
| `pi` | `https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/` | `/guide/edupi/<chapter>` |

Each adapter's explanation table gives a source path (relative to the base) and a guide chapter per event.

## 6. Trace events

Trace events are the teaching extras on top of a native protocol: they show the steps a harness hides (the exact request body, each streamed chunk, prompt assembly, tool dispatch). The real harnesses do not send them. Each backend sends them in its protocol's style:

| Backend | Wire form | Example |
|---|---|---|
| educodex | a JSON-RPC lite notification in the `trace/` namespace; `params` is the payload, plus `threadId`, `turnId`, `iteration` (turn events) and `_seq`, `_ts` | `{"method": "trace/modelRequest", "params": {"api": "openai-responses", "url": ..., "body": ...}}` |
| edupi | a pi-style `type`-tagged line; every other field is the payload | `{"type": "trace", "name": "modelRequest", "api": "openai-completions", "url": ..., "body": ...}` |

Both adapters turn them into the same `TimelineEvent`: `{name: "modelRequest", trace: true, data: payload}` (section 1). So the Inspector reads one name and one set of fields for both backends.

### Shared events

Events that mean the same thing have the same name and the same **shared fields**. A backend may add its own fields to a shared event.

| Name | When | Shared fields | educodex adds | edupi adds |
|---|---|---|---|---|
| `modelRequest` | just before the HTTP request to the model | `api` (string: `openai-responses` or `openai-completions`), `url` (string), `body` (object: the exact request body) | `inputTokensEstimate` | |
| `streamEvent` | for each streamed chunk, raw | `event` (object: one Responses SSE event, or one `chat.completion.chunk`) | (only with `thread/start` `traceSse: true`) | |
| `modelResponse` | when the stream ended | `usage` (object: the harness's usage record), `seconds` (number) | `eventCounts`, `outputItems`, `cost` (the Codex usage is the Responses `usage`) | `stopReason`, `errorMessage` (on errors), `responseId`, `content` (the assistant content blocks), `cost` (as in the `cost` event; absent without usage); `usage` is pi's `Usage` |
| `loopIteration` | after each model reply: does the loop call the model again? | `iteration` (number: model calls so far in this turn or run), `needsFollowUp` (boolean: the reply called tools), `tokens` (number: the context size), `decision` (string: `continue` or `stop`) | `autoCompactLimit`, `contextWindow`; `tokens` is the history's estimate | `stopReason`; `tokens` is the reply's `usage.totalTokens`; `decision` is also `continue` when steering messages wait; sent right after pi's `turn_end` |
| `toolDispatch` | a tool call starts | `tool` (string: the tool name), `callId` (string), `parallel` (boolean: the calls of this reply run at the same time) | `kind` (the Responses item type), `arguments` or `input` (custom tools) | `arguments` (object); sent right after pi's `tool_execution_start` |
| `toolOutput` | a tool call ended | `tool`, `callId`, `output` (string: the text the model reads), `tokens` (number: bytes / 4, rounded up) | | `isError` (boolean), `durationMs` (absent if the call failed before it ran); sent right after pi's `tool_execution_end` |
| `promptAssembled` | the prompt for a turn (educodex) or a run (edupi) is built | `fragments` (array of `{kind, role, source, text, tokens, changed}`: one per prompt part, `changed` = new in this turn's request), `firstTurn` (boolean) | `baseInstructions`; fragments are the developer and user context items | fragments are the system prompt's sections (`preamble`, `tools`, `rules`, `addendum`, `project_context`, `skills`, `cwd`); `removed` (section names); sent before `agent_start` |
| `skillsLoaded` | the skill folders were scanned | `roots` (array of `{path, scope}`), `skills` (array of `{name, description, path, scope}`), `errors` (array of `{path, message}`) | sent every turn (Codex rescans per turn) | `skills[].disableModelInvocation`, `projectTrusted` (boolean: were `<cwd>/.pi` files read); sent once per session, before its first `promptAssembled` |
| `compactionRequest` | just before the compaction's summary request | `reason` (string), `tokensBefore` (number: the context size that triggered it), `body` (object: the exact summary request body) | `reason`: `manual`, `pre-turn` or `auto` | `reason`: `manual`, `threshold` or `overflow`; one event per summary request (a split turn has two) |
| `compacted` | the shorter context replaced the old one | `reason` (string), `summary` (string), `tokensBefore` (number), `tokensAfter` (number: the new context's size, estimated) | `itemsBefore`, `itemsAfter`, `newHistory` (the replacement history) | `firstKeptEntryId`, `details` (`readFiles`, `modifiedFiles`), `messages` (the context rebuilt from the compaction entry) |
| `pricing` | before the first request with a model | `model` (string), `pricing` (object: `{model, perMillionTokens: {prompt, completion, cache_read, cache_write}, longContext, longContextFromTokens}`, or `null` without prices) | `source` or `error`; sent when the thread starts | `source`; pi's `Model.cost` from OpenRouter's model list; sent before the model's first `modelRequest` |
| `cost` | after a response with usage | `last` (object: `{tokens: {input, uncached, cached, cacheWrite, output, reasoning}, cacheHitRate, billedUsd, usd?}`), `total` (object: the session's sums, plus `requests`), `inputItems` (number: items or messages in the request) | `toolsTokens` | `toolsTokens`; pi's `usage.cost` regrouped; also in `modelResponse.cost`; the total starts again with each session |
| `paused` | step mode stopped the loop | `breakpoint` (string: `beforeModelRequest`, `beforeToolCall` or `afterToolCall`), `info` (object) | `info`: `inputItems`, `tools` or `tool`, `callId` | `info`: `messages`, `tools` (counts) or `tool`, `callId`; parallel tool calls pause one at a time |
| `resumed` | the loop goes on | `breakpoint` (string) | | also after an abort |

- `api` picks the request view in the Requests tab: **Chat Completions** messages (`body.messages`: role and content) or **Responses** input items (`body.input`: typed items). A `modelRequest` without `api` is read as `openai-responses`.
- edupi sends a `modelResponse` for failed requests too (`stopReason: "error"`), but only after a `modelRequest`.
- edupi's summary request goes through the same provider as every request, so `modelRequest`, `streamEvent` and `modelResponse` follow its `compactionRequest`. educodex sends only `compactionRequest` for it. edupi's compaction events come between pi's own `compaction_start` and `compaction_end` events.

### Backend-only events

- educodex: `toolsRegistered` (`tools`), `historyChanged`, `policyDecision`, `sandboxCommand`, `sandboxDenied`, `approvalRequested`, `approvalResolved`, `hook`, `mcpToolsListed`, `mcpToolExposed`, `mcpServerFailed`, `skillInjected`, and the memory events.
- edupi: `toolsRegistered` (`tools`: the Chat Completions tool specs of the request, as sent). Same name and field as educodex's, so the Tools tab reads both; edupi sends it just before a `modelRequest` whose tools are new for the session.

The visualiser reacts to `pricing`, `cost`, `paused` and `resumed` (view reducer) and reads `modelRequest`, `modelResponse` (Requests tab), `toolsRegistered`, `toolDispatch` and `toolOutput` (Tools tab).

### Fixtures

`protocol/fixtures/trace/` holds one example per backend and shared event, in the native wire form:

| File | What |
|---|---|
| `shared.json` | each shared event and the JSON type of each shared field |
| `educodex/<name>.json` | an educodex notification (`{method, params}`) |
| `edupi/<name>.json` | an edupi line (`{type: "trace", name, ...}`) |

The rule (`protocol/shape.ts`): a real event **matches** its fixture if it has every key of the fixture with the same JSON type. Objects are checked key by key; arrays by type only; extra keys are allowed. Stream events differ by kind, so a test compares a fixture with a real event of the same kind (a text delta).

Tests that use the fixtures:

- `backends/edupi/test/trace-fixtures.test.ts` (seam A): edupi's events match `edupi/*.json` and `shared.json`.
- `backends/educodex/tests/test_trace_fixtures.py` (seam A): educodex's events match `educodex/*.json` and `shared.json` (the same rule in Python).
- `visualiser/test/trace-fixtures.test.ts` (seam C): both adapters turn each fixture into a trace event with the shared name and fields.

When a payload changes, change the fixture, this section and both backends' tests together.
