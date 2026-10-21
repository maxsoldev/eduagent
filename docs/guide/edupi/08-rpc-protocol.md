# 08 — The RPC protocol

Read [educodex chapter 18, The App Server](../educodex/18-app-server.md) first. It explains why a harness puts a protocol between the agent and its UI. This chapter shows pi's protocol, `pi --mode rpc`, which edupi speaks unchanged.

## Concept

### One process, one session, JSON lines

pi has several modes: the terminal UI, print mode (`-p`), JSON mode (`--mode json`, events only) and **RPC mode** (`--mode rpc`). In RPC mode another program starts pi as a child process and talks to it over stdin and stdout:

- **One JSON object per line**, in both directions. Lines are split on `\n` only. JSON strings can hold U+2028 and U+2029, so a reader must not use line splitters (like Node's `readline`) that also split on those.
- **Commands** go to stdin. Each has a `type` and an optional `id`: `{"id": "2", "type": "prompt", "message": "Say hello."}`.
- **Responses** come on stdout, one per command: `{"id": "2", "type": "response", "command": "prompt", "success": true, "data": {...}}`, or `"success": false` with an `"error"` text.
- **Events** come on stdout too. They have a `type` and no `id`: `{"type": "agent_start"}`.
- stdout carries only protocol lines. Logs go to stderr.

There is no handshake. The process already holds one session when it starts. A client asks `get_state` to learn the session id and the model.

### Commands run concurrently

pi handles each input line as soon as it arrives. It does not wait for the previous command to finish. A slow command does not block a fast one, so responses can come in a different order than the commands. Clients match responses by `id`.

The `prompt` command shows why this matters. Its response does not wait for the reply. It comes as soon as the prompt is accepted, before the run's first event:

```
>> {"id":"2","type":"prompt","message":"Say hello."}
<< {"id":"2","type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}
<< {"type":"agent_start"}
<< {"type":"turn_start"}
<< {"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"Say hello."}],"timestamp":1792594523808}}
<< {"type":"message_end","message":{"role":"user", ...}}
<< {"type":"message_start","message":{"role":"assistant","content":[],"stopReason":"pending", ...}}
<< {"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_start","contentIndex":0}}
<< {"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello from t"}}
<< {"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"he faux model."}}
<< {"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"Hello from the faux model."}}
<< {"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Hello from the faux model."}],"stopReason":"stop", ...}}
<< {"type":"turn_end","message":{...},"toolResults":[]}
<< {"type":"agent_end","messages":[{"role":"user", ...},{"role":"assistant", ...}],"willRetry":false}
<< {"type":"agent_settled","aborted":false}
```

(Real output of `node bin/edupi.mjs --mode rpc --faux ...`, shortened.) A failure after the prompt was accepted gets no second response. It shows up as an event: an assistant message with `stopReason: "error"` and an `errorMessage`.

### Three levels of events

| Level | Events | Meaning |
|---|---|---|
| run | `agent_start` … `agent_end` | One run of the agent loop. `agent_end` lists the run's new messages |
| turn | `turn_start` … `turn_end` | One assistant response and its tool calls |
| message | `message_start`, `message_update`, `message_end` | One message: user, assistant, tool result or system |

`agent_settled` comes from the session, not the loop. It means the session is idle: all retries, compactions and queued messages are done. A client should wait for it, not for `agent_end`, before it says "done".

`message_update` is sent only for assistant messages. Its `assistantMessageEvent` is the provider's stream event (chapter 01) **without** the `partial` message. The client builds the message from `message_start` and the deltas, and `message_end` carries the final message. Only the cumulative `usage` is kept, because its size does not grow.

### get_state

`get_state` answers with the session's state, in pi's field names: `model` (the full model object), `thinkingLevel`, `isStreaming`, `isCompacting`, `steeringMode`, `followUpMode`, `sessionFile`, `sessionId`, `autoCompactionEnabled`, `messageCount` and `pendingMessageCount`. `isStreaming` stays true from the start of a run until `agent_settled`.

### Errors

| Input | Response |
|---|---|
| A line that is not JSON | `{"type":"response","command":"parse","success":false,"error":"Failed to parse command: ..."}`, with no `id` |
| An unknown `type` | `{"id":"1","type":"response","command":"get_tree","success":false,"error":"Unknown command: get_tree"}` |
| A command that throws | `success: false` with the error text, same `id` and `command` |

## In edupi

| File | Mirrors (pi) | What it does |
|---|---|---|
| [`src/coding-agent/modes/rpc/rpc-mode.ts`](../../../backends/edupi/src/coding-agent/modes/rpc/rpc-mode.ts) | `modes/rpc/rpc-mode.ts` | `runRpcMode`: reads lines, runs commands, writes responses and events |
| [`src/coding-agent/modes/rpc/rpc-types.ts`](../../../backends/edupi/src/coding-agent/modes/rpc/rpc-types.ts) | `modes/rpc/rpc-types.ts` | Command, response and state types |
| [`src/coding-agent/modes/rpc/jsonl.ts`](../../../backends/edupi/src/coding-agent/modes/rpc/jsonl.ts) | `modes/rpc/jsonl.ts` | Strict JSONL framing |
| [`src/coding-agent/modes/json-event.ts`](../../../backends/edupi/src/coding-agent/modes/json-event.ts) | `modes/json-event.ts` | `toJsonEvent`: drops `partial` from `message_update` |
| [`src/coding-agent/core/agent-session.ts`](../../../backends/edupi/src/coding-agent/core/agent-session.ts) | `core/agent-session.ts` | `AgentSession`: `prompt`, the run, `agent_settled`, the state getters |
| [`src/agent/agent.ts`](../../../backends/edupi/src/agent/agent.ts), [`src/agent/agent-loop.ts`](../../../backends/edupi/src/agent/agent-loop.ts) | `packages/agent/src/agent.ts`, `agent-loop.ts` | The `Agent` and the loop that emit the run, turn and message events |
| [`src/coding-agent/main.ts`](../../../backends/edupi/src/coding-agent/main.ts) | `main.ts` | Builds the model, `Agent` and `AgentSession`, then `runRpcMode` |

How a line becomes output:

1. `attachJsonlLineReader` cuts stdin into lines. Each line goes to `handleInputLine` without `await`, so lines run concurrently.
2. `handleInputLine` parses the JSON (parse error → `command: "parse"`), then calls `handleCommand`, a `switch` on `type`.
3. `prompt` starts `session.prompt(...)` and returns nothing. The session calls `preflightResult("started")` when the run starts, and that writes the response. If the prompt fails before (no API key, a run is active), the `.catch` writes an error response.
4. `AgentSession` subscribes to the `Agent`. Every agent event goes to its listeners, with `willRetry` added to `agent_end`, and the session adds `agent_settled` at the end of the run.
5. `runRpcMode` subscribes to the session and writes every event with `toJsonEvent`.
6. `takeOverStdout` sends any other `stdout` writes (a stray `console.log`) to stderr, so stdout stays clean.

The tests in [`test/rpc-prompt.test.ts`](../../../backends/edupi/test/rpc-prompt.test.ts) start edupi as a child process, as the launcher does, and check the event order and shapes.

The visualiser talks to edupi with the same pi adapter it uses for the real pi (`visualiser/src/adapters/pi/`): edupi speaks pi's protocol, so nothing in the adapter knows which one it talks to. The adapter takes its wire types from edupi's [`rpc-types.ts`](../../../backends/edupi/src/coding-agent/modes/rpc/rpc-types.ts) and [`json-event.ts`](../../../backends/edupi/src/coding-agent/modes/json-event.ts) (type-only imports from the `@eduagent/edupi` workspace package), so a change to edupi's protocol shows up as a type error in the visualiser.

## In pi

- [`runRpcMode`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L54) in `modes/rpc/rpc-mode.ts`: the [`prompt` case](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L394) with `preflightResult`, the [`get_state` case](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L448), the [unknown-command error](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L715), [`handleInputLine`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L750) and the [event output](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L356).
- [`RpcCommand`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/modes/rpc/rpc-types.ts#L20), [`RpcSessionState`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/modes/rpc/rpc-types.ts#L96) and [`RpcResponse`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/modes/rpc/rpc-types.ts#L116): all of pi's commands, about forty.
- [`serializeJsonLine` and `attachJsonlLineReader`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/modes/rpc/jsonl.ts#L10) in `jsonl.ts`, and [`toJsonEvent`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/modes/json-event.ts#L46).
- [`takeOverStdout`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/output-guard.ts#L45) in `core/output-guard.ts`.
- [`AgentSessionEvent`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/agent-session.ts#L196), [`AgentSession.prompt`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/agent-session.ts#L2058), [`_startRun`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/agent-session.ts#L1837) and [`_emitAgentSettled`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/agent-session.ts#L1079).
- The agent events: [`runAgentLoop`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/agent-loop.ts#L102) and [`streamAssistantResponse`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/agent-loop.ts#L381) in `packages/agent/src/agent-loop.ts`, and [`Agent`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/agent.ts#L188).
- pi's own protocol docs: [`docs/rpc.md`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/docs/rpc.md) and [`docs/rpc-commands.md`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/docs/rpc-commands.md).

## How Codex does it differently

| | pi RPC | Codex App Server |
|---|---|---|
| Message shape | `type`-tagged objects | JSON-RPC lite: `id`, `method`, `params` / `result` / `error` |
| Handshake | none; `get_state` | `initialize` → response → `initialized` |
| Sessions per process | one; `new_session` replaces it | many threads (`thread/start`, `thread/resume`) |
| Starting work | `prompt` → `{disposition: "started"}` | `turn/start` → `{turn}` |
| Events | the agent's own events (`agent_start`, `message_update`, ...) | a UI model: `turn/started`, `item/started`, `item/agentMessage/delta`, `item/completed` |
| Streaming text | `message_update` with the provider's `text_delta` | `item/agentMessage/delta` |
| Server → client requests | none (pi has no approvals) | yes: approval requests the client must answer |
| Transports | stdio only | stdio, WebSocket, Unix socket |
| Matching replies | by `id`; commands run concurrently | by `id` |

The biggest difference is what the events describe. Codex's App Server translates its core events into **items**, a model made for UIs, with a version and generated types ([`ThreadItem`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L236)). pi writes the agent loop's own events, almost unchanged, so a client sees the loop directly: runs, turns, messages and the provider's stream events. In the visualiser, the Codex and pi adapters map these two shapes into the same view.

Codex messages are JSON-RPC lite ([`rpc.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/rpc.rs#L37)); Codex's stdio transport is [`stdio.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-transport/src/transport/stdio.rs#L141).

## Where edupi is simpler

- **Ten commands:** `prompt`, `steer`, `follow_up`, `abort`, `set_thinking_level` (chapter 02), `get_commands` (skills only, chapter 05), `get_state`, `new_session`, `get_messages` (chapter 06) and `compact` (chapter 07), plus edupi's own `debug_` commands (chapter 09). pi has about forty; the others get pi's `Unknown command` error.
- **No extensions**, so no `extension_ui_request` records and no `disposition: "handled"`.
- **No backpressure.** pi's agent waits when stdout is full, so a slow client slows the loop down. edupi lets Node buffer the output.
- **Simpler shutdown.** pi disposes the session and kills the child processes it started. edupi flushes stdout and exits when stdin closes, and exits with 143 on SIGTERM and 129 on SIGHUP, as pi does.
- **Fewer options, and strict.** edupi knows `--mode rpc`, `--model ID` (an OpenRouter id, no patterns), `--session`, `--continue`, `--no-session`, `--approve`, `--offline` and its test flags. Any other option is an error; pi keeps unknown `--flags` for extensions.
- **A simpler start-up model choice.** pi restores the session's model only if its provider has a key, then tries the settings' default model and thinking level. edupi restores any OpenRouter model, else uses `openai/gpt-6-luna` at `medium`, and reads no defaults from `settings.json`.
- **No per-request projection.** pi rebuilds every request's messages from the session file (`prepareRequest`). edupi does this only before later turns (`prepareNextTurn`, chapter 07); the first request of a run uses the Agent's messages, which are the same unless the file was changed from outside.

## Try it

Talk to edupi by hand:

```bash
node bin/edupi.mjs --mode rpc --faux examples/faux/demo.json
{"id":"1","type":"get_state"}
{"id":"2","type":"prompt","message":"Say hello."}
{"id":"3","type":"get_tree"}
not json
```

Watch for the `prompt` response before `agent_start`, `agent_settled` at the end, and the two error responses.

In the visualiser, open one viewer for **edupi** and one for **educodex**, send the same prompt in both, and compare their **Protocol** tabs. If you set up the real pi ([`README.md`](../../../README.md#the-real-pi)), open it in a third viewer: its protocol is the same as edupi's.

## Further reading

- pi's [RPC docs](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/docs/rpc.md) and its [JSON event docs](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/docs/json.md).
- [JSON Lines](https://jsonlines.org/): the format.
- [`docs/features/edupi/pi-vs-codex-transports.md`](../../features/edupi/pi-vs-codex-transports.md): the transport layers of pi and Codex compared.
