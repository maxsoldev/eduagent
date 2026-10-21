# 02 — The loop and the queues

Read [educodex chapter 04, The agentic loop](../educodex/04-agentic-loop.md), and [chapter 08, Reasoning](../educodex/08-reasoning.md) first. They explain turns, iterations, interrupts and reasoning effort in Codex. This chapter shows pi's loop: two nested loops with three points where queued messages go in, abort, and the thinking level.

## Concept

### Runs, turns and drain points

In pi, one prompt starts one **run**: `agent_start` … `agent_end`, then `agent_settled` from the session. A run has one or more **turns**. A turn is one model reply plus the tools it called. (Codex calls the whole run a turn, and one model call an iteration.)

While a run is active, the user can type more messages. pi keeps them in two queues:

- **Steering** messages go in as soon as the current tools are done, before the next model call. Use them to correct the agent: *"Use src/ instead."*
- **Follow-up** messages wait until the agent would stop. Use them for the next task: *"Then summarise."*

The loop takes messages from the queues at fixed **drain points**. pi's `runLoop` has two loops:

```
run:   A: steering ← poll                                       (typed while the run started)
       ┌ outer loop ──────────────────────────────────────────────────────────────────┐
       │ ┌ inner loop: while the model calls tools or steering is pending ──────────┐ │
       │ │  later turns: B: steering ← poll (only if nothing is pending), turn_start │ │
       │ │  pending messages → message_start / message_end                           │ │
       │ │  model call → assistant message                                           │ │
       │ │  tools → toolResult messages                                              │ │
       │ │  turn_end                                                                 │ │
       │ │  C: steering ← poll                                                       │ │
       │ └───────────────────────────────────────────────────────────────────────────┘ │
       │ follow-ups ← poll: if any, they are pending and the outer loop goes on         │
       └──────────────────────────────────────────────────────────────────────────────┘
       agent_end
```

Steering never stops a running tool. A steering message sent during a 10-second `bash` call waits for it, and goes in after the tool result:

```
assistant  tool call: bash "sleep 10; make"
toolResult "…"
user       "Use src/ instead."        ← steering, at drain point C
assistant  "OK, using src/."
```

The order is valid for every API: the tool result directly follows its call, and the steering message is a normal user message after it.

### One at a time

Each queue has a mode, `one-at-a-time` (pi's default) or `all`. In `one-at-a-time` mode a poll takes one message, so three queued steering messages give three turns, each with its own reply. Steering comes before follow-up. With two steering messages and one follow-up, queued during one tool call:

```
turn 1: user "run slow"            assistant → bash         (steer 1, steer 2 and follow 1 are queued)
turn 2: user "steer 1"             assistant "Ack."
turn 3: user "steer 2"             assistant "Ack."
turn 4: user "follow 1"            assistant "Done."        (the agent would stop after turn 3)
```

This is still **one run**: one `agent_start`, one `agent_end`, one `agent_settled`.

### The queues on the wire

Three commands queue a message: `steer`, `follow_up`, and `prompt` with `"streamingBehavior": "steer"` or `"followUp"`. A plain `prompt` while the agent works is refused, so the client must choose. Each answers `{"disposition": "queued"}` at once. The session sends a `queue_update` event with **both full queues** each time one changes:

```jsonl
>> {"id":"2","type":"steer","message":"Use src/ instead."}
<< {"type":"queue_update","steering":["Use src/ instead."],"followUp":[]}
<< {"id":"2","type":"response","command":"steer","success":true,"data":{"disposition":"queued"}}
   … tool_execution_end, toolResult message, turn_end, turn_start …
<< {"type":"queue_update","steering":[],"followUp":[]}
<< {"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"Use src/ instead."}],"timestamp":…}}
```

The second `queue_update` comes **before** the message starts, so a client sees the queue change first. The session finds the message in its queue by its text. `get_state` shows `pendingMessageCount`, `steeringMode` and `followUpMode`.

### Abort

`abort` stops the run. The session aborts the Agent's `AbortController`; the signal reaches the HTTP request and every running tool:

- **During the stream**, the provider stops reading. The reply ends as `stopReason: "aborted"` with the text so far, then `turn_end` and `agent_end`.
- **During a tool**, `bash` kills its process group and returns `Command aborted` as an error result. Parallel calls that did not start get `Operation aborted`. The tool results go into the context, as always. The loop then starts the next turn, but the model call sees the aborted signal and ends at once, with no request sent and an empty reply. In edupi that reply has `stopReason: "aborted"`, as pi's provider sets it. Real pi shows `stopReason: "error"` and `errorMessage: "This operation was aborted"` there: its model runtime resolves the API key with the signal first, and a failure in that setup step is always an `error`.

Then the session sends `agent_settled` with `aborted: true`, and only then the response to `abort`:

```jsonl
>> {"id":"4","type":"abort"}
<< {"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"one two thr"}],"stopReason":"aborted","errorMessage":"Request was aborted",…}}
<< {"type":"turn_end",…}
<< {"type":"agent_end",…,"willRetry":false}
<< {"type":"agent_settled","aborted":true}
<< {"id":"4","type":"response","command":"abort","success":true}
```

Abort does **not** clear the queues. pi's TUI sends `clear_queue` first if the user wants that. `new_session` and `compact` abort a running run before they do their work.

The aborted reply stays in the session, but it does not go back to the model: pi's provider layer (`transformMessages`) leaves out assistant messages with `stopReason` `aborted` or `error`, also when the abort cut a tool call in half. A tool call that has no result (for example in a session file written by a pi that was killed while a tool ran) gets a synthetic error result `No result provided` before the next user message, because the API refuses a tool call without its result.

### Thinking level

pi has one setting for reasoning, the **thinking level**: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. A new session starts at `medium`. Each level is checked against the model:

- A model without reasoning supports only `off`.
- A reasoning model supports `off` to `high`. Its **thinking level map** (from OpenRouter's supported efforts, [chapter 01](01-provider-api.md)) can remove a level (`null`), and `xhigh` and `max` need an entry in it. `openai/gpt-6-luna` supports `off`, `low` to `max`, but not `minimal`.
- An unsupported level is **clamped**: to the next higher supported level, else the next lower one. So `minimal` on `openai/gpt-6-luna` becomes `low`, and `max` on a model without a map becomes `high`.

On the OpenRouter wire the level becomes one `reasoning` object for every model family:

```json
{"model": "openai/gpt-6-luna", "messages": […], "reasoning": {"effort": "high"}}
```

The effort is the level's value in the map, else the level's name. `off` sends `{"effort": "none"}`, which turns reasoning off at OpenRouter; a model whose reasoning is mandatory has no `off` level. A model without reasoning gets no `reasoning` field. The model streams its reasoning in the `reasoning` delta field. pi keeps it as a `thinking` block, with the field name as its `thinkingSignature`, and sends it back in the same field on the next request:

```json
{"role": "assistant", "content": "Hello!", "reasoning": "The user greets me. I greet back."}
```

`set_thinking_level` saves a `thinking_level_change` entry and sends `thinking_level_changed` before its response, but only if the clamped level changed. Each assistant message records the `thinkingLevel` it was asked with. A level set while a run is active applies from the run's next model call: before each later turn, the loop's `prepareNextTurn` hook gets the session's current model and level.

## In edupi

| File | Mirrors (pi) | What it does |
|---|---|---|
| [`src/agent/agent-loop.ts`](../../../backends/edupi/src/agent/agent-loop.ts) | `agent/src/agent-loop.ts` | `runLoop`: the inner and outer loops, drain points A, B and C, the follow-up poll; `runAgentLoopContinue` |
| [`src/agent/agent.ts`](../../../backends/edupi/src/agent/agent.ts) | `agent/src/agent.ts` | `PendingMessageQueue`, `steer`, `followUp`, `abort`, `continue` (starts from queued messages after a reply), `getSteeringMessages` / `getFollowUpMessages` in the loop config |
| [`src/agent/types.ts`](../../../backends/edupi/src/agent/types.ts) | `agent/src/types.ts` | `QueueMode`, the queue callbacks in `AgentLoopConfig` |
| [`src/coding-agent/core/agent-session.ts`](../../../backends/edupi/src/coding-agent/core/agent-session.ts) | `coding-agent/src/core/agent-session.ts` | the queue texts and `queue_update`, `prompt` with `streamingBehavior`, `steer`, `followUp`, `abort` and `waitForIdle`, `agent_settled.aborted`, `setThinkingLevel` |
| [`src/coding-agent/core/agent-session-runtime.ts`](../../../backends/edupi/src/coding-agent/core/agent-session-runtime.ts) | `coding-agent/src/core/agent-session-runtime.ts` | `new_session` aborts the old session's run first |
| [`src/coding-agent/core/defaults.ts`](../../../backends/edupi/src/coding-agent/core/defaults.ts) | `coding-agent/src/core/defaults.ts` | `DEFAULT_THINKING_LEVEL = "medium"` |
| [`src/ai/models.ts`](../../../backends/edupi/src/ai/models.ts) | `ai/src/models.ts` | `getSupportedThinkingLevels`, `clampThinkingLevel` |
| [`src/ai/api/openai-completions.ts`](../../../backends/edupi/src/ai/api/openai-completions.ts) | `ai/src/api/openai-completions.ts` | `streamSimple` (level → `reasoningEffort`), the `reasoning` field, reasoning deltas as thinking blocks and their replay |
| [`src/ai/api/transform-messages.ts`](../../../backends/edupi/src/ai/api/transform-messages.ts) | `ai/src/api/transform-messages.ts` | `transformMessages`: leaves out aborted and failed replies, adds results for tool calls without one |
| [`src/coding-agent/modes/rpc/rpc-mode.ts`](../../../backends/edupi/src/coding-agent/modes/rpc/rpc-mode.ts) | `modes/rpc/rpc-mode.ts` | `steer`, `follow_up`, `abort`, `set_thinking_level` |

The loop, shortened from edupi's `runLoop`:

```ts
let pendingMessages = (await config.getSteeringMessages?.()) || [];           // A
while (true) {
  let hasMoreToolCalls = true;
  while (hasMoreToolCalls || pendingMessages.length > 0) {
    if (lastCompletedTurn) {
      await config.prepareNextTurn?.(lastCompletedTurn);   // may compact (chapter 07); new context, model, level
      if (pendingMessages.length === 0) pendingMessages = (await config.getSteeringMessages?.()) || []; // B
      await emit({ type: "turn_start" });
    }
    for (const message of declareToolChanges(currentContext, pendingMessages)) { /* message_start, message_end */ }
    const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
    if (message.stopReason === "error" || message.stopReason === "aborted") { /* turn_end, agent_end */ return; }
    // … run the tools; hasMoreToolCalls = the reply had tool calls …
    await emit({ type: "turn_end", message, toolResults });
    pendingMessages = (await config.getSteeringMessages?.()) || [];             // C
  }
  const followUpMessages = (await config.getFollowUpMessages?.()) || [];
  if (followUpMessages.length > 0) { pendingMessages = followUpMessages; continue; }
  break;
}
await emit({ type: "agent_end", messages: newMessages });
```

The Agent owns the queues; the loop only calls `getSteeringMessages()` and `getFollowUpMessages()`. The session keeps the texts next to them, for `queue_update`. After the loop, the session goes on (`agent.continue()`) while messages are still queued, for example one sent while the last `agent_end` listeners ran. It does not go on after an abort.

**In the viewer.** Backends with the `queues` capability keep the message box open while a turn runs. **steer** (Enter) sends `steer`, **follow-up** (Alt+Enter, as in pi's TUI) sends `follow_up`, **abort** sends `abort`. The queued messages show above the box, from `queue_update`. The effort select sends `set_thinking_level`. Thinking blocks show as reasoning in the chat. On connect the pi adapter also sends `get_messages`, so a session started with `--session` shows its conversation so far.

The tests in [`test/rpc-queues.test.ts`](../../../backends/edupi/test/rpc-queues.test.ts) check the event order of real pi's queue transcript, a follow-up sent during a stream, abort during a stream and during a tool, `new_session` and `compact` during a run, the `reasoning` field for each thinking level, and the thinking replay. [`test/rpc-provider.test.ts`](../../../backends/edupi/test/rpc-provider.test.ts) checks the request after an abort in the middle of a streamed tool call, and the synthetic results. The visualiser's Seam C test replays a transcript of the real pi with steering, a follow-up and thinking (`visualiser/test/fixtures/pi/queues.out.jsonl`). Playwright steers, follows up and aborts edupi from the viewer (`visualiser/e2e/edupi.spec.ts`).

## In pi

- The loop: [`runLoop`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/agent-loop.ts#L163), [drain point A](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/agent-loop.ts#L176), [the outer loop](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/agent-loop.ts#L179), [B](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/agent-loop.ts#L205), [C](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/agent-loop.ts#L295), [the follow-up poll](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/agent-loop.ts#L302).
- The Agent: [`PendingMessageQueue`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/agent.ts#L143), [`steer`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/agent.ts#L299), [`followUp`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/agent.ts#L304), [`abort`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/agent.ts#L341), [`continue`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/agent.ts#L384), [the queue callbacks](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/agent.ts#L496).
- The session: [queueing a prompt while streaming](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/agent-session.ts#L2102), [`_queueSteer`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/agent-session.ts#L2268), [`_queueFollowUp`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/agent-session.ts#L2285), [the queue removal before `message_start`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/agent-session.ts#L1128), [`abort`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/agent-session.ts#L2464), [`_emitAgentSettled`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/agent-session.ts#L1079), [the post-run loop](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/agent-session.ts#L1864), [`setThinkingLevel`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/agent-session.ts#L2642).
- RPC mode: [`steer`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L416), [`follow_up`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L421), [`abort`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L426), [`set_thinking_level`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L497).
- After an abort: [`transformMessages`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/api/transform-messages.ts#L91), [the skipped replies](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/api/transform-messages.ts#L222), [the synthetic results](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/api/transform-messages.ts#L188).
- Thinking levels: [`getSupportedThinkingLevels`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/models.ts#L1244), [`clampThinkingLevel`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/models.ts#L1255), [`streamSimple`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/api/openai-completions.ts#L738), [OpenRouter's `reasoning` field](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/api/openai-completions.ts#L942), [the reasoning delta fields](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/api/openai-completions.ts#L598).
- Docs: pi's [`sdk.md`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/docs/sdk.md#L66) (steer and follow-up), [`json.md`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/docs/json.md#L121) (`queue_update`), [`settings.md`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/docs/settings.md#L31) (the queue modes).

## How Codex does it differently

| | pi | Codex |
|---|---|---|
| Unit of work | a run of turns; one turn = one model reply and its tools | a turn of iterations (sampling requests) |
| Loop shape | inner loop (tools, steering) inside an outer loop (follow-ups) | one loop: `needs_follow_up = model_needs_follow_up \|\| has_pending_input` |
| Mid-turn input | `steer`: queued in the Agent, one message per drain point by default | `turn/steer`: goes into the active turn's pending input; all of it is drained at the top of the next sampling request |
| After the work | `follow_up`: a queue in the agent core, same run | no core queue: the TUI keeps queued messages and starts a new turn with them |
| Who sees the queue | every client: `queue_update` with both queues | the TUI only (pending steers and queued messages are client state) |
| Abort | `abort`: aborted reply, tool error results, `agent_settled {aborted: true}`, then the response | `turn/interrupt`: the turn ends as `interrupted`, open calls get `aborted` outputs, a `<turn_aborted>` user message goes into history |
| What the model sees after an abort | the tool results; the aborted reply is left out of the next request | the `<turn_aborted>` message that says the user stopped the turn |
| Reasoning setting | thinking level `off` … `max`, clamped per model, default `medium` | reasoning effort (`minimal` … `xhigh`) from the model catalog's default and supported levels |
| On the wire | OpenRouter's `reasoning: {effort}` on Chat Completions; reasoning text replayed in the `reasoning` field | Responses API `reasoning: {effort, summary}`; encrypted reasoning items replayed |

The biggest difference is **where the follow-up lives**. In pi it is part of the agent core, so every mode (TUI, RPC, SDK) gets it, and the run goes on without a new prompt. In Codex the core knows only "pending input for the active turn"; waiting for the turn to end is the client's job.

The second is **granularity**. pi delivers one steering message per turn, so each correction gets its own reply. Codex drains all pending input before the next request, so several messages typed during one tool call reach the model together.

The Codex side: the [loop](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/turn.rs#L424) and its [`get_pending_input`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/turn.rs#L428), [`needs_follow_up`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/turn.rs#L573), [`steer_input`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/turn_input.rs#L794), the [`turn/steer`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/protocol/common.rs#L1056) request, the regular task that [starts again while input is pending](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tasks/regular.rs#L120), the TUI's [queued messages](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/tui/src/chatwidget/input_queue.rs#L28), the [interrupt marker](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tasks/mod.rs#L102), and [`build_reasoning`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/client.rs#L869). educodex's loop is in [chapter 04](../educodex/04-agentic-loop.md); it has no mid-turn input.

## Where edupi is simpler

- **No `clear_queue`, no queue mode commands.** The modes stay at pi's default `one-at-a-time` (no `set_steering_mode`, `set_follow_up_mode`, no settings for them).
- **No input handlers or prompt templates.** pi runs extension input handlers and expands prompt templates on queued text too; edupi expands only `/skill:` commands (as for `prompt`), so the disposition is always `queued`, never `handled`.
- **No thinking budgets**, no `cycle_thinking_level`, no saved default level.
- **No `reasoning_details`.** OpenRouter can also stream structured, sometimes encrypted, reasoning details; pi keeps and replays them. edupi keeps the reasoning text only.
- **No `prepareRequest` / `finishTurn` hooks** and no explicit continuation. pi's session uses them for its per-request projection, virtual models and extension `turn_end` handlers.
- **No extension hooks in the loop.** No `transformContext`, `beforeToolCall` / `afterToolCall` (pi's extension `tool_call` / `tool_result` events and image resizing), no `terminate` on tool results (a batch where every result says `terminate` ends the run).
- **No model runtime.** The stream function calls the provider directly. pi's goes through `ModelRuntime.streamSimple`, which resolves auth first; so after an abort during a tool, pi's next reply is an `error` and edupi's an `aborted`.
- **A shorter `transformMessages`.** edupi's copy has pi's two passes (thinking from another model, then dropped replies and synthetic tool results), but no image downgrade and no tool call id normalization: OpenRouter's ids and edupi's text-only models need neither.

## Try it

In the visualiser, open **edupi** (with a real model) and ask for something slow: *"Run `sleep 8; ls` and tell me what you see."* While the command runs:

- type *"Also count the files."* and press **steer**. The queue above the box shows it. When the command ends, it goes in after the tool result. Watch the **Timeline**: `queue_update`, then after `turn_end` a new `turn_start`, a second `queue_update` and the user `message_start`.
- type *"Then say goodbye."* and press **follow-up**. It runs only after the agent has answered.
- send another slow task and press **abort**. The command card ends as aborted, the turn as interrupted. In the **Protocol** tab the `abort` response comes after `agent_settled`.

Set the effort select to **high** and send a prompt. In the **Requests** tab, find `"reasoning": {"effort": "high"}` in the body. Set it to **minimal**: the request says `low` (clamped, `openai/gpt-6-luna` has no `minimal`). The reasoning shows in the chat above the reply.

Offline, over stdio, with the faux script that runs a slow command:

```bash
EDUPI=$PWD; mkdir -p /tmp/edupi-queues && cd /tmp/edupi-queues
node $EDUPI/bin/edupi.mjs --mode rpc \
  --faux $EDUPI/examples/faux/queues.json --faux-log /tmp/edupi-queues.requests.jsonl
{"id":"1","type":"prompt","message":"Run a slow command."}
{"id":"2","type":"steer","message":"Use src/ instead."}
{"id":"3","type":"follow_up","message":"Then summarise."}
```

Send the second and third lines while the command runs (it takes 3 seconds). Then look at the order of the user messages in the last request, and at its `reasoning` field:

```bash
tail -1 /tmp/edupi-queues.requests.jsonl | jq '.body.reasoning, [.body.messages[] | select(.role == "user") | .content[0].text]'
```

Run the tests:

```bash
npx vitest run test/rpc-queues.test.ts
```

## Further reading

- pi's [`sdk.md`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/docs/sdk.md#L66): steering and follow-up from the SDK.
- pi's [`rpc.md`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/docs/rpc.md): the `steer`, `follow_up`, `abort` and `set_thinking_level` commands.
- OpenRouter, [Reasoning tokens](https://openrouter.ai/docs/use-cases/reasoning-tokens): the `reasoning` object and its `effort` values.
- [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/): the Codex loop, for comparison.
- [educodex chapter 08](../educodex/08-reasoning.md): reasoning in the Responses API.
