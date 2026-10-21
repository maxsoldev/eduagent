# 19 — Clients and observability

## Concept

### One protocol, many clients

Chapter 18 put a protocol between the harness and the UI. The benefit shows up here: every client is just a JSON-RPC reader and writer. It does not need to know about prompts, SSE or sandboxes. A client has four jobs:

1. **Connect and handshake:** `initialize`, then `initialized`.
2. **Send requests:** `thread/start`, `turn/start`, `turn/interrupt`.
3. **Build its view from notifications:** `item/started` creates an entry, deltas extend it, and `item/completed` gives it its final form.
4. **Answer server requests:** show an approval prompt and reply with the same `id`.

So a web page, a terminal app and a test script all work the same way. Codex's VS Code extension, desktop app, JetBrains and Xcode integrations are all clients of the same App Server.

### Derive state from events

A good client keeps **no state of its own** about the agent. Its state is a function of the messages it has received:

```
state = reduce(initialState, [notification1, notification2, ...])
```

This has useful consequences:
- **Reconnecting is easy.** Ask the server for the thread (`thread/read`) and replay.
- **Two clients agree.** The same events give the same picture.
- **Testing is easy.** Feed in a recorded event list and check the result.

### Observability: seeing what the agent did

When an agent does something odd, "the model was wrong" is rarely the full answer. You need to see what it was *given*: which prompt, which tools, which outputs, and which policy decisions. Production harnesses record this for debugging, telemetry and evals. educodex goes one step further and puts it in the UI, live, as `trace/*` events (chapter 18).

Useful things to record, roughly in order of value:

| Signal | Answers |
|---|---|
| The exact request body per model call | "What did the model actually see?" |
| Usage per call (input, cached input, output) | Cost, and whether the prompt cache is hitting |
| Loop decisions and iteration count | "Why did it stop / keep going?" |
| Policy and sandbox decisions | "Why was this command allowed / blocked / asked about?" |
| Tool latency and output size | Slow tools; outputs that eat the context window |
| Compactions (tokens before/after) | How often long sessions lose detail |

Recorded sessions (chapter 16) can then be replayed, compared across harness versions, or turned into eval cases.

### Testing without a model

Real models are slow, cost money, and give different answers each time. For tests and offline demos, a harness can swap the model for a **fake** that replays scripted responses in the real wire format. The rest of the harness (loop, tools, policy, protocol, UI) runs for real.

## In educodex

### Web UI ([`web/src/`](../../../visualiser/src/))

| File | Job |
|---|---|
| [`launcher.ts`](../../../visualiser/src/launcher.ts), [`components/BackendPicker.tsx`](../../../visualiser/src/components/BackendPicker.tsx) | The first screen: pick a backend and a working directory. Opening one goes to `?backend=educodex&cwd=...` |
| [`rpc.ts`](../../../visualiser/src/rpc.ts) | JSON-RPC lite over WebSocket. Sorts incoming messages into notification, server request or response. When the socket closes, it passes on the launcher's reason (for example `educodex exited with code 1`) |
| [`store.ts`](../../../visualiser/src/store.ts) | A React reducer. All UI state comes from notifications |
| [`App.tsx`](../../../visualiser/src/App.tsx) | Handshake, controls (model, approval, sandbox, step mode, **compact**, new thread), and what each slash command does |
| [`components/Composer.tsx`](../../../visualiser/src/components/Composer.tsx), [`commands.ts`](../../../visualiser/src/commands.ts) | The message box with the `/` command list and the `$` skill list. It stays disabled until `thread/start` has returned a thread |
| [`components/Chat.tsx`](../../../visualiser/src/components/Chat.tsx) | Items as a chat, plus approval cards. The buttons come from the request's `availableDecisions`, so `acceptWithExecpolicyAmendment` appears only when the server offers it (it answers with the proposed rule). A `serverRequest/resolved` notification removes the card |
| [`components/Inspector.tsx`](../../../visualiser/src/components/Inspector.tsx) | The inspector tabs |
| [`explain.ts`](../../../visualiser/src/explain.ts) | One explanation per event, with a guide chapter and a Codex link |

`rpc.ts` tells the three kinds of incoming message apart by their fields:

```ts
if (message.method && message.id !== undefined) {
  this.h.onServerRequest(message.id, message.method, message.params);   // approval
} else if (message.method) {
  this.h.onNotification(message.method, message.params);
} else if (typeof message.id === "number") {
  // response to one of our requests: resolve or reject the pending promise
}
```

`store.ts` is the "state from events" idea in about 100 lines. Streaming items live in `live` until they complete:

```ts
case "item/started":
  return { ...s, live: { ...s.live, [rest.item.id]: { ...rest.item } } };
case "item/agentMessage/delta":
case "item/commandExecution/outputDelta": {
  const cur = s.live[rest.itemId];
  ...
  return { ...s, live: { ...s.live, [rest.itemId]: { ...cur, [field]: (cur[field] ?? "") + rest.delta } } };
}
case "item/completed": {
  const live = { ...s.live };
  delete live[rest.item.id];
  return { ...s, live, chat: [...s.chat, { kind: "item", item: rest.item }] };
}
```

Every notification is also appended to `events`, which the inspector reads. Every message in either direction is appended to `wire`.

**Inspector tabs:**

| Tab | Built from | Shows |
|---|---|---|
| Timeline | every event | One row per step, with its explanation and JSON. Category chips filter rows; **follow** keeps the newest row in view |
| Context | `debug/context/get` | The exact `input` of the next request, coloured by source, with a context-window bar. **zoom to used** (on by default) scales the bar to what is used; turn it off to see the whole window and the auto-compact marker |
| Requests | `trace/modelRequest` | Each request body. It checks that earlier items are "unchanged ✓ (prompt cache can hit)" |
| Tools | `trace/toolsRegistered`, `trace/mcpToolsListed` / `trace/mcpToolExposed` | Tool specs as sent; for MCP, raw vs exposed side by side |
| Guardrails | `trace/policyDecision`, `trace/sandboxCommand`, approvals | Why each command was allowed, sandboxed or asked about |
| Protocol | `wire` | Every JSON-RPC message, filterable |

**`explain.ts`** turns the UI into a teaching tool. Each event name maps to a title, a category colour, a short text, the guide chapter and a Codex path:

```ts
"trace/compacted": { title: "History compacted", category: "memory", chapter: "15", codex: "core/src/compact.rs",
  text: "History was replaced by recent user messages + fresh context + the summary." },
```

The "guide ch.15" link opens `/guide/educodex/15`. The launcher serves the matching `docs/guide/educodex/15-*.md` file.

### The launcher ([`launcher/`](../../../launcher/))

The browser cannot start a process, and educodex speaks stdio, as `codex app-server` does by default. The **launcher** sits between them (see [ADR 0002](../../adr/0002-launcher-with-stdio-backends.md)). `pnpm eduagent` at the repo root starts it on http://127.0.0.1:8765. It does four things:

1. It serves the built visualiser (`visualiser/dist/`) and the guide (`/guide/<backend>/<chapter>`).
2. `GET /backends` returns the backends from [`launcher/backends.json`](../../../launcher/backends.json), and the default directory (where you ran `pnpm`). Each entry has a name, the harness it re-implements, its protocol, its command and its capabilities. A git-ignored `launcher/backends.local.json` can add entries or replace one with the same name. `${REPO}` and `${ENV_VAR}` in a command or env value are replaced.
3. A viewer opens a WebSocket at `/backends/<name>?cwd=<dir>`. For each WebSocket, the launcher starts a **new** backend process in that directory, without a shell ([`pipe.ts`](../../../launcher/src/pipe.ts)):

   ```ts
   createInterface({ input: child.stdout! }).on("line", (line) => ws.send(line));
   ws.on("message", (data) => child.stdin!.write(`${data}\n`));
   ```

   One frame is one stdin line and one stdout line is one frame. Nothing is parsed, so the **Protocol** tab shows exactly what educodex wrote. stderr goes to the launcher's console as `[educodex 4242] ...`.
4. When the viewer closes, the launcher closes the process's stdin (educodex stops at end of input), and kills it if it does not stop. When the process exits first, the launcher closes the WebSocket with code 1011 and a reason such as `educodex exited with code 1`, and the viewer shows it.

The launcher binds to 127.0.0.1 and refuses WebSocket upgrades whose `Origin` is not a loopback address. A page on another site could otherwise start a backend and run commands on your machine. It also refuses HTTP requests whose `Host` is not loopback (DNS rebinding).

Because each viewer has its own process, two browser tabs never share threads. Open educodex in one tab and another backend in a second tab, send the same prompt, and compare.

### TUI over stdio ([`tui.py`](../../../backends/educodex/src/educodex/tui.py))

The Textual TUI starts `educodex app-server --listen stdio://` (the default transport) as a child process and speaks JSONL over its pipes. It is the same protocol as the web UI, only over a different transport:

```python
while line := await self.proc.stdout.readline():
    message = json.loads(line)
    if "method" in message and "id" in message:  # server -> client request (approval)
        screen = ApprovalScreen(message["method"], message["params"], message["id"])
        self.push_screen(screen, ...)
    elif message.get("method") == "serverRequest/resolved":  # e.g. the turn was interrupted
        ...  # close the matching approval screen
    elif "method" in message:
        self.on_notification(message["method"], message.get("params", {}))
    elif (future := self.pending.pop(message.get("id"), None)) is not None:
        ...
```

On the left is the chat; on the right is a one-line summary of selected `trace/*` events (`TRACE_SUMMARY`). Closing stdin is the shutdown signal.

### Slash commands and `$` mentions

Codex's TUI opens a list when you type `/` (commands) or `$` (skills). Both clients here do the same. The commands are a **client** feature: the server does not know them. Each command is one app-server request:

| Command | Request | Chapter |
|---|---|---|
| `/skills` | `skills/list`, printed into the chat | 14 |
| `/new` | `thread/start` | 18 |
| `/compact` | `thread/compact/start` | 15 |
| `/memory-update` | `memory/update/start` (educodex) | 17 |
| `/memory-drop` | `memory/reset` | 17 |

The order is Codex's: its enum order is the order in the list ([`slash_command.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/tui/src/slash_command.rs#L12)). The list shows exact matches first, then prefix matches ([`command_popup.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/tui/src/bottom_pane/command_popup.rs#L159)). In Codex, the two memory commands are hidden debug stubs (`/debug-m-update`, `/debug-m-drop`).

The `$` list comes from `skills/list` and is fetched again each time you start a mention, so a new `SKILL.md` shows up at once. Picking a skill inserts `$name` and remembers its path. On send, the web UI adds a `{"type": "skill", "name", "path"}` item for each picked skill that is still in the text. The path is exact, so even two skills with the same name work. The TUI shows the matches in a hint line, completes the first one with →, and sends text only; the server then matches plain `$name`.

### CLI printer ([`cli.py`](../../../backends/educodex/src/educodex/cli.py))

`educodex exec "task"` skips the protocol completely. It subscribes `print_event` directly to the core's `EventBus` and prints a `rich` timeline: prompt assembly, each model request, loop decisions, policy decisions, tool output. With `-v` it also prints each full request body as JSON, the streaming deltas and every other `trace/*` event. This shows the core is UI-agnostic: the app server is just one more subscriber.

`EventBus.emit` ([`events.py`](../../../backends/educodex/src/educodex/core/events.py)) catches errors from listeners and prints them to stderr. A broken printer or a closed socket can never stop a turn.

### The observability seam ([`core/probe.py`](../../../backends/educodex/src/educodex/core/probe.py))

The package has two parts:
- [`src/educodex/core/`](../../../backends/educodex/src/educodex/core/) is the harness. It stays as close to Codex as possible: loop, tools, policy, sandbox, MCP, hooks, compaction, protocol events.
- [`src/educodex/observe/`](../../../backends/educodex/src/educodex/observe/) holds what educodex adds for teaching: the `trace/*` events ([`tracer.py`](../../../backends/educodex/src/educodex/observe/tracer.py)), costs ([`pricing.py`](../../../backends/educodex/src/educodex/observe/pricing.py)) and step mode ([`stepper.py`](../../../backends/educodex/src/educodex/observe/stepper.py)).

They meet at one seam, a `Probe`. At each point worth watching, the core makes a one-line call such as `await ctx.probe.sandbox_denied(...)`. The base `Probe` does nothing, so a `Session` without a probe emits only protocol events. The hosts (`cli.py`, the app server) pass `Session(..., probe=Tracer())`; the Tracer emits on the session's event bus. The core never imports `observe/`, and it never builds a trace payload itself (`tests/test_layers.py` checks the imports).

Why bother? So the core reads like Codex, not like Codex plus debug output. Codex has the same kind of seam: at the same points it calls its OpenTelemetry layer, e.g. [`otel.sandbox_outcome(...)`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/orchestrator.rs#L430) in `tools/orchestrator.rs` when the sandbox denies a command.

The core side, in [`tools/handlers.py`](../../../backends/educodex/src/educodex/core/tools/handlers.py#L112):

```python
if sandboxed and _is_likely_sandbox_denied(result.output, result.exit_code):
    await ctx.probe.sandbox_denied(ctx, cmd, result.exit_code)
```

The matching [`Tracer`](../../../backends/educodex/src/educodex/observe/tracer.py#L146) method builds the event:

```python
async def sandbox_denied(self, ctx, command, exit_code) -> None:
    await self._turn(ctx, "trace/sandboxDenied", command=command, exitCode=exit_code,
                     note="The model sees the denial and may retry with sandbox_permissions=require_escalated.")
```

The `Tracer` also owns step mode (`probe.checkpoint(ctx, "beforeToolCall", ...)` pauses there) and pricing: it calls `ModelClient.list_models()` and parses prices with `pricing_from_models()`.

### The fake model ([`testing/fake_model.py`](../../../backends/educodex/src/educodex/testing/fake_model.py))

`FakeModel` is an `httpx` transport. It replaces the network, not the client code, so `client.py` still builds the real request and parses real SSE. A script is a list of responses, and each response is a list of output items:

```json
[
  [{"type": "function_call", "name": "exec_command", "arguments": "{\"cmd\": \"ls -la\"}"}],
  [{"type": "message", "text": "Done."}]
]
```

`sse_events` expands each item into `response.output_item.added`, text deltas, `response.output_item.done` and `response.completed` with a usage block. Every request body is saved in `fake.requests`, so tests can check exactly what was sent (for example, `tests/test_turn.py::test_request_shape_matches_codex`).

It is used in three places:
- **Python tests** ([`tests/conftest.py`](../../../backends/educodex/tests/conftest.py) `make_session`), including a TUI test that drives a real stdio child ([`tests/test_tui.py`](../../../backends/educodex/tests/test_tui.py)).
- **Offline demos:** `--fake-model examples/fake/demo.json` works on `exec`, `app-server` and `tui` (it is a common option). The demo plans, runs `ls`, writes `hello.py` with `apply_patch`, runs it, and asks approval for `rm -rf build`.
- **Browser e2e tests:** [`web/e2e/ui.spec.ts`](../../../visualiser/e2e/ui.spec.ts) with Playwright. [`playwright.config.ts`](../../../visualiser/playwright.config.ts) starts the app server with the demo script, then the test clicks through a full turn, declines the approval and checks every inspector tab. A second test steps through a turn in step mode.

## In Codex

- **Clients on the same protocol:** [`app-server-client/src/lib.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-client/src/lib.rs#L1) is the "shared in-process app-server client facade for CLI surfaces like TUI and exec". The [TUI](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/tui) depends on it ([`tui/Cargo.toml`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/tui/Cargo.toml#L32)). It sends app-server messages over in-process channels instead of a pipe ([`app-server/src/in_process.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server/src/in_process.rs)).
- **A tiny reference client:** [`app-server-test-client/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-test-client/src), used by [`codex debug app-server send-message-v2`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/cli/src/main.rs#L288) to print the JSON of a full turn.
- **Typed client bindings:** [`codex app-server generate-ts`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/cli/src/main.rs#L636) generates TypeScript types from the Rust protocol.
- **Fake model in tests:** Codex runs a mock HTTP server (`wiremock`) and builds SSE bodies with helpers like [`sse`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/tests/common/responses.rs#L753), [`ev_function_call`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/tests/common/responses.rs#L969) and [`mount_sse_sequence`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/tests/common/responses.rs#L1469). The integration tests are in [`core/tests/suite/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/tests/suite).
- **Observability:**
  - [`otel/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/otel) exports OpenTelemetry logs, traces and metrics.
  - [`rollout-trace/`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/rollout-trace/src/lib.rs#L1) defines a "trace bundle format, writer, and reducer for Codex rollouts".
  - JSON-RPC requests can carry a [W3C trace context](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/rpc.rs#L52), so a client's trace continues into the server.

## Where educodex is simpler

- **Trace events are for people, not dashboards.** Codex sends telemetry to OTel collectors. educodex sends `trace/*` to the UI and keeps them in memory per thread.
- **Untyped clients.** The web UI uses `any` for payloads. Codex clients use generated types.
- **Simple reconnects.** `thread/read` with `includeTrace` returns the whole event log. Codex has thread resume, history paging and lossless event queues.
- **One fake-model script per thread.** Each `thread/start` creates a fresh `FakeModel`, so "new thread" restarts the script. A manual compaction also uses up one scripted response.
- **The launcher is not part of Codex.** Codex's clients start `codex app-server` themselves (stdio), or connect to its WebSocket or Unix socket listener (chapter 18). educodex needs the launcher only because a browser cannot start a process.
- **The TUI is minimal:** no diff view, no history browsing, five slash commands (Codex has about 60), and a hint line instead of a selectable list.

## Try it

1. **Web UI, offline:** add a fake-model entry to `launcher/backends.local.json` (the launcher reads it next to `backends.json`):
   ```json
   { "backends": [{ "name": "educodex-demo", "harness": "Codex", "protocol": "codex-app-server",
     "command": ["uv", "run", "-q", "--project", "${REPO}/backends/educodex", "educodex", "app-server",
                 "--fake-model", "${REPO}/backends/educodex/examples/fake/demo.json"] }] }
   ```
   ```bash
   cd ../.. && pnpm install && pnpm build && mkdir -p /tmp/edx && pnpm eduagent --cwd /tmp/edx
   ```
   Open http://127.0.0.1:8765, pick **educodex-demo**, and send any message (the box unlocks once the thread has started). Click rows in the **Timeline** and follow the "guide ch.NN" and "Codex:" links. In **Requests**, confirm that each request only appends items.
2. **With a real model**, drop `--fake-model` (needs `OPENROUTER_API_KEY`) and compare the **Protocol** tab with the sequence in chapter 18.
3. **TUI:**
   ```bash
   uv run educodex tui --fake-model examples/fake/demo.json --cwd /tmp/edx
   ```
   The same demo runs in the terminal. The approval appears as a modal.
4. **CLI printer:** `uv run educodex exec -v "list the files here"` with a real model, or offline: `uv run educodex exec --cwd /tmp/edx --fake-model examples/fake/demo.json "go"`.
5. **Tests:**
   ```bash
   uv run --group dev pytest tests/test_app_server.py tests/test_tui.py   # the protocol over stdio, with the fake model
   cd ../.. && pnpm --filter @eduagent/visualiser exec playwright install chromium && pnpm build && pnpm test:e2e
   ```
   Playwright starts the launcher with [`launcher/backends.test.json`](../../../launcher/backends.test.json): educodex with the fake model and a temporary home, plus two small test backends (`echo` and `crash`).
6. **Write your own client.** In ~30 lines of Python, start `educodex app-server --listen stdio://`, opt out of every `trace/*` method, and print only `item/completed` items. That is a complete (if plain) agent UI.

## Further reading
- [Unlocking the Codex harness: how we built the App Server](https://openai.com/index/unlocking-the-codex-harness/): how local apps, Codex Web and the TUI integrate.
- [Harness engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/): making logs, metrics and the UI "legible" to agents, with an observability stack per worktree.
- [Designing agentic loops](https://simonw.substack.com/p/designing-agentic-loops): what to watch for when you let an agent run.
