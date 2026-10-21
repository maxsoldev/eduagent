# eduagent protocol spec

Each backend speaks its harness's native protocol (ADR 0001). The visualiser has one **adapter** per protocol. The adapter maps native messages into one neutral **view model**, and the chat, the Inspector and the context bar read only that view model. This document is the contract between adapters and the rest of the visualiser.

Contents:

1. View model (the types every adapter produces)
2. View actions (how an adapter changes the view)
3. Adapter interface
4. Capabilities (which panels a backend entry shows)
5. Harness links (timeline source and guide links)
6. Trace events (shared vocabulary, to be completed in ticket #11)

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

A `Turn` is `{id: string | null, status: "running" | "completed" | "interrupted" | "failed" | null, durationMs?, entries: Entry[]}`. A turn with `id: null` holds entries outside any backend turn (slash-command notes, errors between turns). The chat draws a separator `turn <status> · <seconds>s` after each ended turn.

### Entries

Every entry has a unique `id`. An adapter sends the same id again to update the entry (for example when a streamed item completes).

| `kind` | Fields | Codex source | pi source |
|---|---|---|---|
| `user` | `text`, `skills: {name, path}[]` | `userMessage` item | user `message_start`/`message_end` (`skills` stays empty: pi expands `/skill:name` into the text) |
| `assistant` | `text`, `streaming`, `part?` | `agentMessage` item, `item/agentMessage/delta` | one entry per text block of an assistant message: `text_start`, `text_delta`, then `message_end` |
| `reasoning` | `summary: string[]`, `streaming` | `reasoning` item, `item/reasoning/summaryTextDelta` | thinking content (not mapped yet: no recorded transcript has it) |
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

- **Session:** a `get_state` reply with a new `sessionId` gives a `session` action. The client sends `get_state` on connect, and `new_session` then `get_state` for "new thread". Every timeline event gets the current session id.
- **Turn:** the first `agent_start` opens a turn (`<session>-t<n>`); `agent_settled` ends it, `interrupted` if `aborted`, else `completed`. A retry inside one run (a second `agent_start` before `agent_settled`) stays in the same turn. `durationMs` runs from the first message's `timestamp` to the end of the last reply (`timestamp + durationMs`).
- **Entry ids:** messages are counted (`<session>-m<n>`); a text block is `<message>-c<contentIndex>`; a tool is its `toolCallId`; a compaction `<session>-k<n>`.
- **Replies** (`type: "response"`) are not timeline events; the client matches them by `id`.
- **Commands sent:** `get_state`, `new_session`, `prompt`, `abort`, `compact`, `set_thinking_level`, `get_commands` (skills: `source: "skill"`, name `skill:<name>`). A prompt with a `$skill` becomes `/skill:<name> <text>`, which pi expands. Steering and follow-up (`steer`, `follow_up`) are not sent yet.

Seam C fixtures: `visualiser/test/fixtures/pi/` (`chat`, `abort`, `compact`; `meta.json` has the pi commit), recorded by `visualiser/test/record-pi.mjs`.

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

Timeline and Protocol always show, because they also list native messages. The test entry `educodex-plain` in `launcher/backends.test.json` has no capabilities (`visualiser/e2e/view.spec.ts`).

## 5. Harness links

Timeline links come from the backend entry's `harness` (`visualiser/src/view/harness.ts`):

| Harness | Source base (pinned commit) | Guide section |
|---|---|---|
| `Codex` | `https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/` | `/guide/educodex/<chapter>` |
| `pi` | `https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/` | `/guide/edupi/<chapter>` |

Each adapter's explanation table gives a source path (relative to the base) and a guide chapter per event.

## 6. Trace events

Ticket #11 writes the shared trace vocabulary here: names, payload shapes and JSON fixtures. The visualiser already reads these trace events by name: `modelRequest` (`url`, `body`; `api` picks the request view, `openai-responses` if absent), `modelResponse`, `toolsRegistered` (`tools`), `historyChanged`, `promptAssembled`, `pricing` (`pricing.perMillionTokens`), `cost` (`last`, `total`, `inputItems`), `paused` (`breakpoint`, `info`), `resumed`, and the Codex-only `policyDecision`, `sandboxCommand`, `sandboxDenied`, `approvalRequested`, `approvalResolved`, `mcpToolsListed`, `mcpToolExposed`.
