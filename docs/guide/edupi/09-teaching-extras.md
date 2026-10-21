# 09 — Teaching extras: step mode, the context inspector and cost

Read [educodex chapter 19, Clients and observability](../educodex/19-clients-and-observability.md) first, and the step mode and `debug/context/get` part of [chapter 18](../educodex/18-app-server.md). They explain the idea: the core calls a probe at each point worth watching, and the teaching extras turn those calls into trace events, pauses and cost numbers. edupi does the same for pi. This chapter shows only what is different.

## Concept

### pi has no debugger, so edupi adds one

pi shows a lot over RPC: every agent event, every streamed delta. But three things stay hidden:

- **The exact next request.** pi builds the Chat Completions body inside the provider, just before the HTTP call. No command returns it.
- **A way to stop the loop between steps.** pi's loop runs from `agent_start` to `agent_settled` without a pause.
- **Cost per request, with the prompt cache.** pi prices each response (`usage.cost` in every assistant message), but it does not show how much of the input came from the cache.

edupi adds these as **teaching extras**, in pi's own style: three new RPC commands with a `debug_` prefix and snake_case names, and trace events as `{type: "trace", name, ...}` lines. Real pi answers the `debug_` commands with `Unknown command`, so the launcher lists the capabilities `stepMode` and `contextInspector` only for edupi.

| Command | Response `data` | What it does |
|---|---|---|
| `{"type": "debug_set_step_mode", "enabled": true, "breakpoints"?: [...]}` | `{enabled, breakpoints}` | Turns step mode on or off. Breakpoints: `beforeModelRequest`, `beforeToolCall`, `afterToolCall` (default: all three). Off releases a pause. |
| `{"type": "debug_continue"}` | none | Ends the current pause. |
| `{"type": "debug_get_context"}` | `{body, messageCount, tokens, contextWindow, autoCompactLimit}` | The exact next request body, pi's token count, the model's context window and pi's compaction limit. |

### Step mode: three checkpoints in pi's loop

The checkpoints are the same as educodex's, at the same steps of the loop:

1. **`beforeModelRequest`**: after the loop turned the AgentMessages into provider messages (`convertToLlm`), before the request is built and sent.
2. **`beforeToolCall`**: after `tool_execution_start`, before the tool's arguments are checked and the tool runs.
3. **`afterToolCall`**: after `tool_execution_end`, before the tool result message.

At each checkpoint the loop awaits the probe. While step mode is on, the probe sends `paused {breakpoint, info}` and waits; `debug_continue` ends the wait and the probe sends `resumed {breakpoint}`.

pi runs the tool calls of one reply in parallel (chapter 04). Two calls can reach `afterToolCall` at the same time. edupi pauses them **one after the other**, so each `debug_continue` releases exactly one pause:

```
<< {"type":"trace","name":"paused","breakpoint":"beforeToolCall","info":{"tool":"bash","callId":"call_1"}}
>> {"id":"5","type":"debug_continue"}
<< {"type":"trace","name":"resumed","breakpoint":"beforeToolCall"}
<< {"type":"tool_execution_start","toolCallId":"call_2", ...}
<< {"type":"trace","name":"paused","breakpoint":"beforeToolCall","info":{"tool":"bash","callId":"call_2"}}
```

An `abort` also ends a pause: the probe gets the run's abort signal. The aborted run then sends no request.

### The context inspector: the next request, built the same way

`debug_get_context` builds the body the way the loop does: the Agent's messages through `convertToLlm`, then pi's `streamSimple` options (the model's `maxTokens`, the thinking level as the reasoning effort), then the provider's `buildParams`. So the body has the collapsed system prompt (chapter 03), the tools declared in the transcript (chapter 04) and the `reasoning` field (chapter 02), exactly as they are sent.

- **While paused at `beforeModelRequest`**, the body is the next request, byte for byte. The tests check this against the request the faux provider then receives.
- **When idle**, the body is the conversation so far. The next prompt adds its user message, and a system message if the prompt's sections changed.

`tokens` and `autoCompactLimit` are the two numbers pi's threshold rule compares (chapter 07): the context size from the last reply's usage plus estimates for the messages after it, and `contextWindow - reserveTokens` (16384 by default, from `settings.json`). The context bar draws them, so you can watch a session get close to compaction.

### The loop's decision: `loopIteration`

After each model reply, right after pi's `turn_end`, the loop calls `probe.loopIteration`. The tracer sends `loopIteration {iteration, needsFollowUp, tokens, stopReason, decision}`, the same event as educodex's ([educodex chapter 04](../educodex/04-agentic-loop.md)). `needsFollowUp` is true when the reply called tools. `decision` is `continue` when the loop calls the model again: for tool results, or for steering messages that wait (chapter 02). A follow-up message can still start a new inner loop after a `stop`. `tokens` is the reply's `usage.totalTokens`, the number pi's threshold rule starts from.

### Cost: pi's usage, regrouped

pi already prices every response: its provider multiplies the usage by the model's prices (`Model.cost`, USD per million tokens, from OpenRouter's model list in edupi; chapter 01). edupi's tracer regroups these numbers into educodex's shapes, so the cost panel reads both backends:

- `pricing {model, pricing: {perMillionTokens: {prompt, completion, cache_read, cache_write}}}`, once per model, before its first request. `pricing` is `null` when OpenRouter's list does not have the model (offline, or an unknown id).
- `cost {last, total, inputItems, toolsTokens}` after each response: the input split into uncached, cache reads and cache writes, the dollars for each part, what the same request costs without the cache, and the running total for the session. `modelResponse` carries the same `cost`, for the Requests tab.

The summary request of a compaction goes through the same provider, so it has a cost too.

## In edupi

| File | What |
|---|---|
| [`src/agent/types.ts`](../../../backends/edupi/src/agent/types.ts) | `AgentProbe.checkpoint(name, info, signal)` and the `Checkpoint` names; `AgentProbe.loopIteration` |
| [`src/agent/agent-loop.ts`](../../../backends/edupi/src/agent/agent-loop.ts) | The three `checkpoint` calls: in `streamAssistantResponse`, after `toolDispatch`, and in `emitToolExecutionEnd`; `loopIteration` after each `turn_end` in `runLoop` |
| [`src/observe/stepper.ts`](../../../backends/edupi/src/observe/stepper.ts) | `Stepper`: breakpoints, one pause at a time, release on continue, step mode off or abort |
| [`src/observe/tracer.ts`](../../../backends/edupi/src/observe/tracer.ts) | `Tracer.checkpoint` (`paused`, `resumed`), `loopIteration`, `pricing`, `cost`; `sessionStarted` resets the total |
| [`src/observe/pricing.ts`](../../../backends/edupi/src/observe/pricing.ts) | pi's `usage.cost` in educodex's cost shapes |
| [`src/observe/debug.ts`](../../../backends/edupi/src/observe/debug.ts) | The `debug_` commands; `getContext` builds the next body |
| [`src/coding-agent/modes/rpc/rpc-mode.ts`](../../../backends/edupi/src/coding-agent/modes/rpc/rpc-mode.ts) | The `debug_` cases; `main.ts` passes `debugCommands(tracer)` in |

The core only calls `probe.checkpoint(...)`. It does not know about pauses: the Tracer (in `src/observe/`) decides whether to wait. `test/layers.test.ts` checks that the core does not import `src/observe/`.

`debug_get_context` uses the provider's `buildParams` and `toCompletionsOptions`, the option mapping that `streamSimple` uses too, so the inspector and the real request cannot drift apart.

In the visualiser, the pi adapter ([`visualiser/src/adapters/pi/client.ts`](../../../visualiser/src/adapters/pi/client.ts)) sends the three commands. Its `context()` maps the `debug_get_context` reply with [`piContext`](../../../visualiser/src/adapters/pi/context.ts), and asks again after each `modelResponse`, `toolOutput`, `compacted`, `paused` and `promptAssembled` trace event.

## In pi

pi has no step mode and no context command. The nearest parts:

- [`get_session_stats`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L593) returns token and cost totals and `contextUsage` ([`getContextUsage`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/agent-session.ts#L4267)): the token count, the context window and the percentage. It has no request body.
- The provider's [`onPayload`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/types.ts#L178) option sees each body just before it is sent; extensions use it to inspect or change the body.
- The loop's [`beforeToolCall` and `afterToolCall` hooks](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/agent-loop.ts#L683) are awaited, so an extension could pause a tool call there. edupi's checkpoints sit at the same steps, plus one before [`streamAssistantResponse`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/agent-loop.ts#L381) calls the model.
- Costs: [`calculateCost`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/models.ts#L1220); the threshold rule: [`shouldCompact`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/compaction/compaction.ts#L267).

## How Codex does it differently

Codex has no step mode either; both are educodex's and edupi's own. The two backends use the same breakpoint names, the same trace events (`paused`, `resumed`, `pricing`, `cost`, in `protocol/README.md` section 6) and the same Context tab:

| | educodex | edupi |
|---|---|---|
| Commands | JSON-RPC `debug/stepMode/set`, `debug/continue`, `debug/context/get` (per thread) | `debug_set_step_mode`, `debug_continue`, `debug_get_context` (one session per process) |
| Next request | a Responses body: `instructions`, typed `input` items, `tools` | a Chat Completions body: `messages` (one system message first), `tools`, `reasoning` |
| Compaction limit | Codex's `effective_auto_compact_limit`: at most 90% of the context window | the window minus pi's `reserveTokens` |
| Parallel tool pauses | each paused call waits for the same continue | one pause at a time, one continue each |
| Prices | read with `GET /models` when the thread starts | pi's `Model.cost`, from the model list edupi reads at start |

## Where edupi is simpler

- **Breakpoints only at the three checkpoints.** No pause before a compaction's summary request, as in educodex.
- **No prompt cache in the faux provider.** Its usage has no cached tokens, so offline the cost panel shows 0% read from cache. A real OpenRouter model reports them.
- **One rate per kind.** pi's `Model.cost` has no long-context prices, so `pricing.longContext` is always `null`.

## Try it

1. **In the viewer:** add `"stepMode"` to an `edupi-faux` entry's capabilities (see the [README](README.md#the-visualiser)) and use `examples/faux/step.json`, which prices the model and runs one `bash` call. Tick **step mode**, send a message, and open the **Context** tab while it is paused. Press **Continue** and watch the tab change after each step. The cost panel and the header badge show the prices from the script's model list.
2. **Over stdio:**
   ```bash
   node bin/edupi.mjs --mode rpc --faux examples/faux/step.json
   {"id":"1","type":"debug_set_step_mode","enabled":true}
   {"id":"2","type":"prompt","message":"Run a command."}
   {"id":"3","type":"debug_get_context"}
   {"id":"4","type":"debug_continue"}
   ```
   Compare the `body` of reply 3 with the `modelRequest` trace event that comes after `debug_continue`.
3. **Tests:** `npx vitest run test/rpc-debug.test.ts` (step mode, context) and `test/rpc-trace.test.ts` (pricing and cost).

## Further reading

- [educodex chapter 19](../educodex/19-clients-and-observability.md): the probe seam and what is worth recording.
- [OpenRouter: prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching) and [usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting): where `cached_tokens` and `usage.cost` come from.
