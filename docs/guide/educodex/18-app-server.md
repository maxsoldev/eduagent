# 18 — The App Server

## Concept

### Why put a protocol between the harness and the UI?

Codex runs in a terminal, in VS Code, in JetBrains and Xcode, in a desktop app and on the web. All of them use **one** harness. The [Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/) post tells the story:
- The CLI started as a terminal UI that called the Rust core directly.
- For the VS Code extension the team needed the same loop without rewriting it. They first tried exposing Codex as an MCP server, but MCP's semantics did not fit. So they added a JSON-RPC protocol that mirrored the TUI loop.
- Partners then wanted to embed the harness too. That turned the protocol into a stable, backward-compatible API: the **App Server**.

The App Server is two things: a **protocol**, and a **long-lived process** that hosts threads. A UI never runs the agent loop itself. It sends requests and draws what the server tells it.

```
 VS Code / desktop / TUI / web UI         App Server process
 ───────────────────────────────          ───────────────────────────────────
  request  {"id":3,"method":"turn/start"} ──►  message processor ──► core thread
  ◄── response {"id":3,"result":{...}}                                   │
  ◄── notification {"method":"item/started", ...}  ◄── events ───────────┘
  ◄── request  {"id":"srv-2","method":"item/commandExecution/requestApproval"}
  response {"id":"srv-2","result":{"decision":"decline"}} ──►
```

### JSON-RPC "lite"

[JSON-RPC 2.0](https://www.jsonrpc.org/specification) defines three message shapes. Codex keeps them but leaves out the `"jsonrpc": "2.0"` field:

| Shape | Example | Reply? |
|---|---|---|
| request | `{"id": 1, "method": "thread/start", "params": {}}` | yes, with the same `id` |
| response | `{"id": 1, "result": {...}}` or `{"id": 1, "error": {"code": -32600, "message": "..."}}` | – |
| notification | `{"method": "item/started", "params": {...}}` (no `id`) | no |

**Both sides can send requests.** This is the important part. When the agent needs approval, the *server* sends a request to the *client* and the turn waits for the answer.

**Transports.** The same messages can travel in three ways. Codex picks one with `codex app-server --listen URL`:
- **`stdio://` (the default):** JSONL, one JSON object per line on stdin and stdout. This is what IDEs and the desktop app use: they start the App Server as a child process, and the process ends when its stdin closes.
- **`ws://IP:PORT`:** a WebSocket listener, with one JSON message per text frame. Many clients can connect to one long-lived server.
- **`unix://` or `unix://PATH`:** the same WebSocket protocol, but over a Unix domain socket (a file) instead of a TCP port. Codex uses it as a local control socket for a shared background server. Only processes that can open the file can connect.

educodex has only stdio. In the visualiser, the launcher starts one educodex process per viewer and passes WebSocket frames to its stdin and stdout (chapter 19).

### The handshake

Before anything else, the client sends `initialize`, the server replies, and the client sends the `initialized` notification. Here the client says who it is and what it supports. One capability is `optOutNotificationMethods`, a list of exact method names the client does not want to receive.

### Three primitives: thread, turn, item

| Primitive | What it is | Lifecycle |
|---|---|---|
| **Thread** | A conversation. It is saved on disk and can be resumed | `thread/start` → `thread/started` |
| **Turn** | One user input and all the work it causes (many model calls and tools, chapter 04) | `turn/start` → `turn/started` … `turn/completed` |
| **Item** | One thing to draw: user message, agent message, reasoning, command, file change, MCP call, compaction | `item/started` → optional `item/…/delta` → `item/completed` |

A client can render an item as soon as `item/started` arrives, append the deltas, and replace it with the final version on `item/completed`. It never needs to understand Responses API items, SSE or tool-call formats.

### A real message sequence

This is captured from `educodex app-server --listen stdio://` with a fake model that asks to run `rm -rf build`. `>>` is client to server, `<<` is server to client. IDs and some fields are shortened.

```text
>> {"id":1,"method":"initialize","params":{"clientInfo":{"name":"demo","version":"0"}}}
<< {"id":1,"result":{"userAgent":"educodex/0.1.0","codexHome":"/Users/you/.eduagent/.educodex","platformFamily":"unix","platformOs":"darwin"}}
>> {"method":"initialized"}
>> {"id":2,"method":"thread/start","params":{}}
<< {"method":"thread/started","params":{"thread":{"id":"04da…","model":"openai/gpt-6-luna","cwd":"/private/tmp/edx-demo/ws","status":"idle",…}}}
<< {"id":2,"result":{"thread":{"id":"04da…",…},"model":"openai/gpt-6-luna","approvalPolicy":"on-request","sandbox":{"type":"workspaceWrite"},…}}
>> {"id":3,"method":"turn/start","params":{"threadId":"04da…","input":[{"type":"text","text":"clean up"}]}}
<< {"id":3,"result":{"turn":{"id":"9872…","items":[],"status":"inProgress",…}}}
<< {"method":"turn/started","params":{"threadId":"04da…","turn":{"id":"9872…","status":"inProgress",…}}}
<< {"method":"item/started","params":{"item":{"type":"userMessage","content":[{"type":"text","text":"clean up"}],…},…}}
<< {"method":"item/completed","params":{"item":{"type":"userMessage",…},…}}
<< {"method":"thread/tokenUsage/updated","params":{"tokenUsage":{"total":{"totalTokens":1050,"inputTokens":1000,…},"last":{"totalTokens":1050,…},"modelContextWindow":272000},…}}
<< {"method":"item/started","params":{"item":{"type":"commandExecution","id":"call_a70e…","command":"rm -rf build","status":"inProgress",…},…}}
<< {"id":"srv-2","method":"item/commandExecution/requestApproval","params":{"itemId":"call_a70e…","command":"rm -rf build",
     "reason":"`rm -rf build`: dangerous command (forced rm) always needs approval","availableDecisions":["accept","acceptForSession","decline","cancel"],…}}
>> {"id":"srv-2","result":{"decision":"decline"}}
<< {"method":"serverRequest/resolved","params":{"threadId":"04da…","requestId":"srv-2"}}
<< {"method":"item/completed","params":{"item":{"type":"commandExecution","command":"rm -rf build","status":"declined",…},…}}
<< {"method":"item/started","params":{"item":{"type":"agentMessage","id":"me_1935…","text":""},…}}
<< {"method":"item/agentMessage/delta","params":{"itemId":"me_1935…","delta":"Done."}}
<< {"method":"item/completed","params":{"item":{"type":"agentMessage","id":"me_1935…","text":"Done."},…}}
<< {"method":"thread/tokenUsage/updated","params":{"tokenUsage":{"total":{"totalTokens":2100,…},"last":{"totalTokens":1050,…},…},…}}
<< {"method":"turn/completed","params":{"turn":{"id":"9872…","status":"completed","items":[],"durationMs":3,…}}}
>> {"id":4,"method":"initialize","params":{}}
<< {"id":4,"error":{"code":-32600,"message":"Already initialized"}}
```

Notice:
- `turn/start` answers **immediately** with `"status": "inProgress"`. The real work arrives later as notifications.
- The approval is a request **from the server** with id `"srv-2"`. The turn is paused until the client answers it.
- Decisions are `accept`, `acceptForSession`, `decline` (the model is told and carries on) and `cancel` (the turn is also interrupted). After the answer, `serverRequest/resolved` tells every client the request is settled, so a second window can close its approval card too.
- `thread/tokenUsage/updated` carries Codex's camelCase breakdown: `total` for the whole thread, `last` for the latest model call, and the context window size.
- `initialize` works only once per connection.

## In educodex

The server is three files in [`app_server/`](../../../backends/educodex/src/educodex/app_server/):

| File | Job |
|---|---|
| [`connection.py`](../../../backends/educodex/src/educodex/app_server/connection.py) | One client: send messages, apply opt-outs, send server→client requests and match their responses |
| [`processor.py`](../../../backends/educodex/src/educodex/app_server/processor.py) | Method table; turns requests into session calls and core events into notifications |
| [`main.py`](../../../backends/educodex/src/educodex/app_server/main.py) | The stdio transport: one JSON message per line on stdin/stdout |

**Server→client requests** are a future stored by id. When a message has no `method`, it is a response, and `resolve` completes the future:

```python
async def request(self, method: str, params: dict[str, Any]) -> Any:
    request_id = f"srv-{next(self._ids)}"
    future = asyncio.get_running_loop().create_future()
    self._pending[request_id] = future
    await self.send({"id": request_id, "method": method, "params": params})
    try:
        return await future
    finally:
        self._pending.pop(request_id, None)
        await self.notify("serverRequest/resolved", {"threadId": params.get("threadId"), "requestId": request_id})
```

The `finally` also runs when the turn is interrupted: cancelling the turn cancels the `await`, and the client still learns that the request is gone. Only the interrupted thread's request is affected. When a connection closes, `cancel_pending` answers its open requests with `cancel`.

The stdio transport handles **every line in its own task**. Otherwise a turn waiting for approval would block the reader that has to receive that approval:

```python
while line := await reader.readline():
    ...
    task = asyncio.create_task(processor.handle(conn, message))
```

At end of input (the client closed stdin) it disconnects and shuts the threads down, as Codex's stdio transport does. Any other `--listen` URL is refused with Codex's error text: `` unsupported --listen URL `ws://127.0.0.1:8765`; expected `stdio://` ``.

**Core events become notifications.** The core never imports `app_server` (see [the design doc](../../design.md#architecture)). It emits events on an `EventBus` ([`events.py`](../../../backends/educodex/src/educodex/core/events.py)). `MessageProcessor._broadcast` sends each event only to the connections subscribed to that thread (the one that started it, plus any that called `thread/read` or `turn/start` on it), adding `_seq`/`_ts` fields so UIs can order their timeline. A failing listener is logged and skipped; it never breaks the turn. `Connection.notify` drops methods listed in `optOutNotificationMethods`.

**Methods.** `initialize`, `thread/start`, `thread/list`, `thread/read`, `turn/start`, `turn/interrupt`, `thread/compact/start`, `model/list`, `skills/list` (chapter 14) and `memory/reset` (chapter 17) use Codex's names and main fields. `turn/start` accepts `{"type": "skill", "name", "path"}` input items next to the text, as Codex does. Some rules copied from Codex:
- Any method other than `initialize` sent before it gets `-32600 "not initialized"`; a second `initialize` gets "Already initialized".
- `turn/start` while a turn is running is rejected *before* its overrides (model, sandbox, cwd …) are applied, so it cannot change the running turn's settings.
- `thread/compact/start` replies `{}` at once; the compaction runs as the thread's task (chapter 15).
- `turn/interrupt` stops only that thread's turn.

**educodex extensions** (not in Codex):
- `trace/*` notifications show the hidden steps: `trace/promptAssembled`, `trace/modelRequest`, `trace/loopIteration`, `trace/policyDecision`, `trace/compacted` and more. A Codex-style client can opt out of them with `optOutNotificationMethods`, so it stays compatible.
- **Step mode** ([`stepper.py`](../../../backends/educodex/src/educodex/observe/stepper.py)): `debug/stepMode/set {threadId, enabled, breakpoints}` pauses the loop at `beforeModelRequest`, `beforeToolCall` and `afterToolCall`. The server emits `trace/paused` and waits for `debug/continue`.
- `debug/context/get` returns the exact request body the next model call would send, with token counts. The Context tab uses it.
- `thread/read` with `includeTrace: true` returns the full event log, so a UI that reconnects can rebuild its timeline.
- `memory/update/start {threadId}` runs the memory write path now and replies `{}` at once; a `memoryUpdate` item and `trace/memory*` events follow (chapter 17). Codex starts that pipeline on its own and has no method for it.

**Origin check.** A web page on any site can open a WebSocket to `127.0.0.1`. If it could talk to the server, it could start turns and approve its own commands. Codex's WebSocket listener rejects *any* request with an `Origin` header. educodex has no listener, so the check moved to the launcher: it accepts only loopback origins, because it must allow the visualiser's own page (chapter 19).

## In Codex

- **JSON-RPC lite:** [`app-server-protocol/src/rpc.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/rpc.rs#L1) starts with "We do not do true JSON-RPC 2.0, as we neither send nor expect the `"jsonrpc": "2.0"` field." [`JSONRPCMessage`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/rpc.rs#L37) is request / notification / response / error. Requests may also carry a W3C `trace` context.
- **Method table:** [`protocol/common.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/protocol/common.rs#L500) maps names to typed params with macros: [`initialize`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/protocol/common.rs#L500), [`thread/start`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/protocol/common.rs#L552), [`turn/start`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/protocol/common.rs#L1044), server requests such as [`item/commandExecution/requestApproval`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/protocol/common.rs#L1784), notifications such as [`turn/completed` and `item/started`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/protocol/common.rs#L1967), and the client notification [`initialized`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/protocol/common.rs#L2083).
- **Handshake types:** [`InitializeParams`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/protocol/v1.rs#L29), [`InitializeCapabilities`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/protocol/v1.rs#L46) (with `optOutNotificationMethods`, `experimentalApi`, …) and [`InitializeResponse`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/protocol/v1.rs#L74). The ["Not initialized"](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server/src/message_processor.rs#L975) guard is in the message processor.
- **v2 shapes:** [`protocol/v2/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/protocol/v2): [`ThreadItem`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L236), [`CommandExecutionApprovalDecision`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L66), [`ThreadStartParams`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L62), [`TurnStartParams`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L167). The same Rust types generate TypeScript (`codex app-server generate-ts`) and JSON Schema for clients in other languages.
- **Transports:** [`app-server-transport/src/transport/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-transport/src/transport). [`from_listen_url`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-transport/src/transport/mod.rs#L122) parses `--listen`: `stdio://` is the [default](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-transport/src/transport/mod.rs#L120), and the others are `unix://`, `unix://PATH`, `ws://IP:PORT` and `off` ([error text](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-transport/src/transport/mod.rs#L100); the [CLI flag](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/cli/src/main.rs#L583)). [`stdio.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-transport/src/transport/stdio.rs#L141) appends `\n` to each message. [`websocket.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-transport/src/transport/websocket.rs#L129) is the WebSocket listener (with `/readyz` and `/healthz`), and it [rejects any request with an `Origin` header](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-transport/src/transport/websocket.rs#L89). [`unix_socket.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-transport/src/transport/unix_socket.rs#L43) accepts WebSocket connections on a Unix control socket.
- **Server:** [`app-server/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server/src) (message processor, request processors, thread manager). [`in_process.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server/src/in_process.rs) runs the same protocol without a process boundary (chapter 19).

## Where educodex is simpler

- **A small subset** of methods. Codex also has thread resume/fork/archive, turn steering, review mode, config, auth, MCP and plugin management, file search and many more.
- **Loose types.** Params are plain dicts. Codex generates every type from Rust, and that schema is the contract with clients. educodex copies the main fields, but small differences remain (for example, `turn/completed` items and some optional fields).
- **No versioning or experimental gating.** Codex hides experimental methods and fields unless the client sets `experimentalApi`.
- **stdio only.** Codex also has a WebSocket listener (`ws://IP:PORT`) and a Unix socket listener (`unix://`), where many clients share one long-lived server. educodex has one process per client, and the launcher (not part of Codex) connects the browser to it. The launcher's origin check allows loopback origins instead of rejecting all of them.
- **No backpressure or bounded queues.** Codex carefully bounds its channels so a slow client cannot block the core.

## Try it

1. **Talk to the server by hand.** Start it on stdio and paste one line at a time (no API key needed):
   ```bash
   mkdir -p /tmp/edx && uv run educodex app-server --fake-model examples/fake/demo.json --cwd /tmp/edx
   ```
   ```json
   {"id":1,"method":"initialize","params":{"clientInfo":{"name":"me","version":"0"},"capabilities":{"optOutNotificationMethods":["trace/historyChanged","trace/sseEvent"]}}}
   {"method":"initialized"}
   {"id":2,"method":"thread/start","params":{}}
   {"id":3,"method":"turn/start","params":{"threadId":"<thread id from id 2>","input":[{"type":"text","text":"make hello.py"}]}}
   ```
   When `item/commandExecution/requestApproval` arrives, answer it with its id: `{"id":"srv-…","result":{"decision":"decline"}}`.
2. **Remove the noise.** Add `"trace/promptAssembled"`, `"trace/modelRequest"` and other `trace/*` names to `optOutNotificationMethods`. What is left is what a Codex client would see.
3. **Step mode.** After `thread/start`, send `{"id":4,"method":"debug/stepMode/set","params":{"threadId":"…","enabled":true}}`. Then start a turn and send `{"id":5,"method":"debug/continue","params":{"threadId":"…"}}` after each `trace/paused`.
4. **Watch the wire in the browser.** Build the visualiser and start the launcher at the repo root: `(cd ../.. && pnpm install && pnpm build && pnpm eduagent)`. Open http://127.0.0.1:8765, pick **educodex** and use the **Protocol** tab. It lists every message in both directions, exactly as educodex wrote them on stdout. For an offline run, pick **educodex-demo** ([the fake-model entry](README.md#the-web-ui)).
5. **See the refusal.** Run `uv run educodex app-server --listen ws://127.0.0.1:8765` and read the error. Compare it with Codex's [`--listen` parser](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-transport/src/transport/mod.rs#L122).

## Further reading
- [Unlocking the Codex harness: how we built the App Server](https://openai.com/index/unlocking-the-codex-harness/): why JSON-RPC, the three primitives, and how IDEs, web and the TUI embed it.
- [JSON-RPC 2.0 specification](https://www.jsonrpc.org/specification): the original that "JSON-RPC lite" simplifies.
- [Model Context Protocol specification](https://modelcontextprotocol.io/specification/latest): another JSON-RPC protocol with server→client requests, and the one Codex tried first.
