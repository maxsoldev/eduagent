# 04 — The agentic loop

## Concept

### Turns and iterations

Chapters 02 and 03 gave us one model call and one tool call. An agent chains them:

```
user: "fix the failing test"                                   ┐
   iteration 1: model → exec_command("pytest")   → harness runs it  │
   iteration 2: model → apply_patch(...)         → harness applies  │  one turn
   iteration 3: model → exec_command("pytest")   → harness runs it  │
   iteration 4: model → "Fixed: the test expected 3, not 4."        ┘
user: "thanks, now commit it"                                  ← next turn
```

- A **turn** starts with one user message and ends when the model answers without asking for a tool. Control goes back to the user.
- An **iteration** (Codex calls it a *sampling request*) is one model call plus the tools it asked for.

One turn can have hundreds of iterations. The [Unrolling](https://openai.com/index/unrolling-the-codex-agent-loop/) post puts it this way: the loop repeats "until the model stops emitting tool calls and instead produces a message for the user".

### `needs_follow_up`: the one flag that drives the loop

After each model call, the harness asks one question: *did the model ask for any tool?*

```python
while True:
    needs_follow_up = run_sampling_request()   # True if the reply had tool calls
    if needs_follow_up:
        continue                               # send the tool outputs back to the model
    break                                      # the model answered: the turn is over
```

If yes, the tool outputs are in history and the model must see them, so we call it again. If no, the last item was a message to the user and we stop.

A turn can also end for other reasons:
- **Error.** The API failed after retries. The turn ends as `failed`.
- **Interrupt.** The user pressed stop. The turn ends as `interrupted` (see below).
- **Context full.** Before continuing, the harness may have to compact history first (chapter 14).
- **Stop hook.** A hook may say "not done yet" and keep the loop going (preview below).

### Several tools in one reply

With `"parallel_tool_calls": true`, a model can ask for several tools in one reply, like reading three files at once. Two questions follow.

**In what order do results go into history?** In the order of the calls, always. The model sees `call_1, call_2, output_1, output_2`, however long each tool took.

**May they run at the same time?** Only if they are safe together. Two reads are fine. Two patches to one file are not. Codex uses a **read/write lock**:
- a tool marked *parallel-safe* takes the **read** side. Many readers can hold it together;
- every other tool takes the **write** side. It waits until it is alone, and blocks everyone else.

```
calls:   read_a (parallel)   read_b (parallel)   apply_patch (serial)
time ─►  [ read_a ]
         [ read_b ]
                              [ apply_patch ]   ← waits for both reads, runs alone
```

### Interrupts

The user can stop a turn at any time. The harness cancels the running request and tools. Two things keep history valid and honest:
1. Calls without an output get a synthetic `"aborted"` output (chapter 03), because the API rejects dangling calls.
2. A user message tells the model what happened, so the next turn doesn't continue as if nothing did:

```
<turn_aborted>
The user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.
</turn_aborted>
```

### Stop hooks (preview)

When the model wants to stop, the harness can run a user-defined **Stop hook**: a program that checks the result, for example "do the tests pass?". If the hook blocks, its reason becomes a new user message and the loop goes on. The flag `stop_hook_active` tells the hook it already fired once, so it can avoid an endless loop. Chapter 13 covers hooks.

## In educodex

[`turn.py`](../../src/educodex/turn.py) `run_turn` holds the loop:

```python
while True:
    ctx.iteration += 1
    needs_follow_up = await run_sampling_request(ctx)
    tokens = session.history.token_count()
    limit = session.model_info.effective_auto_compact_limit()
    ...
    if needs_follow_up and tokens >= limit:
        await compact.run_compact(ctx, reason="auto")
        continue
    if needs_follow_up:
        continue
    if continuation := await hooks.run_stop(ctx, stop_hook_active):
        stop_hook_active = True
        await session.record(user_message(continuation))
        continue
    break
```

`run_sampling_request` streams one reply. It records every `output_item.done` item and collects tool calls. When the stream ends it runs them and returns `bool(tool_calls) or end_turn_false`. That return value is `needs_follow_up`. The second part covers a server that sends `end_turn: false` in `response.completed`: it wants another round even without tool calls, and Codex honours that too.

`run_tool_calls` starts every call as a task in an `asyncio.TaskGroup` and returns results in call order (`[t.result() for t in tasks]`). Inside each task the lock decides who may overlap:

```python
async with lock.read() if handler and handler.supports_parallel else lock.write():
    output = await session.router.dispatch(call, ctx)
```

`exec_command`, `write_stdin` and read-only MCP tools are parallel-safe (as in Codex), so several commands can run side by side. `apply_patch` and `update_plan` take the write lock and run alone. `ReadWriteLock` (same file, ~30 lines) is a small asyncio version of tokio's `RwLock`. If one call raises `TurnAborted` (the user picked "cancel" at an approval prompt), the TaskGroup cancels the others.

Interrupts arrive as `asyncio.CancelledError` from `Session.interrupt()`. `run_turn` catches them and records the `<turn_aborted>` message:

```python
except (asyncio.CancelledError, TurnAborted):
    turn["status"] = "interrupted"
    await session.record(user_message(f"<turn_aborted>\n{TURN_ABORTED_GUIDANCE}\n</turn_aborted>"))
```

The next request then goes through `history.for_prompt()`, which adds `"aborted"` outputs for any calls left open.

Each iteration emits `trace/loopIteration` with `needsFollowUp`, token usage and `decision` (`continue` or `stop`).

## In Codex

- [`run_turn`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/turn.rs#L163) in `core/src/session/turn.rs`. The loop starts at [line 424](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/turn.rs#L424).
- [`needs_follow_up = model_needs_follow_up || has_pending_input`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/turn.rs#L573). Codex also continues when the user typed a new message mid-turn.
- [Compaction when the context is full](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/turn.rs#L608), then [`if !needs_follow_up`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/turn.rs#L656) runs Stop hooks. A block sets [`stop_hook_active = true`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/turn.rs#L691) and continues.
- [`try_run_sampling_request`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/turn.rs#L2513) streams one reply. Tool futures go into a [`FuturesOrdered`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/turn.rs#L2580), which yields results in call order. [`drain_in_flight`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/turn.rs#L2460) records them after the stream ends.
- [`handle_output_item_done`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/stream_events_utils.rs#L315) in `core/src/stream_events_utils.rs` records a tool call, starts it right away, and [sets `needs_follow_up = true`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/stream_events_utils.rs#L356).
- If the server says `end_turn: false`, Codex [also continues](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/turn.rs#L2989).
- [`ToolCallRuntime`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/parallel.rs#L46) in `core/src/tools/parallel.rs` holds the `RwLock`. Parallel-safe tools [take `read()`, others `write()`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/parallel.rs#L211).
- A tool is serial unless it says otherwise ([default `false`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/tools/src/tool_executor.rs#L122)). `exec_command` [returns `true`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs#L142), and so does [`write_stdin`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs#L48). MCP tools are parallel-safe when they are [read-only](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/handlers/mcp.rs#L142).
- The interrupt marker: [`TurnAborted`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/context/turn_aborted.rs#L10) in `core/src/context/turn_aborted.rs` (the text and the `<turn_aborted>` tags), recorded by [`interrupted_turn_history_marker`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tasks/mod.rs#L102).

## Where educodex is simpler

- **Tools start after the stream.** Codex starts each tool as soon as its `output_item.done` arrives, while the model is still writing. educodex waits for `response.completed`. History order is the same either way.
- **No mid-turn input.** Codex lets you "steer" a running turn with new messages (`has_pending_input`). educodex runs one turn at a time and accepts input only between turns.
- **Less compaction.** No post-turn compaction and no context-window-exceeded recovery (chapter 14).

## Try it

Give the model a task that needs at least two iterations:

```bash
uv run educodex exec "List the files in this directory, then tell me how many there are."
```

Each `model request #N` block ends with a line like `loop needs_follow_up=True → continue`. The last one says `→ stop`. Add `-v` to print every trace event and request body.

In the web UI (`uv run educodex app-server`, then http://127.0.0.1:8765):
- the **Timeline** tab shows each `loopIteration` with its decision, between the model requests and tool calls;
- tick **step mode** to pause before each model request and before and after each tool call (breakpoints `beforeModelRequest`, `beforeToolCall`, `afterToolCall`), and step through the loop by hand;
- press **interrupt** while a turn is running (step mode makes this easy). Then open the **Context** tab and find the `<turn_aborted>` user message at the end.

Offline: `uv run educodex app-server --fake-model examples/fake/demo.json` replays a 7-iteration turn (plan, `ls`, patch, run, a dangerous `rm -rf` that needs approval, plan, answer). Send any message and watch the Timeline. The same flag works for `exec`: `uv run educodex exec --fake-model examples/fake/demo.json "go"` prints all 7 iterations in the terminal (run it in a scratch folder with `--cwd`, since it creates `hello.py`).

## Further reading
- [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/): turns, iterations and the growing prompt.
- [Designing agentic loops](https://simonw.substack.com/p/designing-agentic-loops): Simon Willison on what makes a loop work.
- [How to Build an Agent](https://ampcode.com/how-to-build-an-agent): the same loop in a few hundred lines.
- [Around the Loop: Building a Coding Agent Harness in Python](https://eddmann.com/posts/around-the-loop-building-a-coding-agent-harness-in-python/).
- [Building effective agents](https://www.anthropic.com/research/building-effective-agents): when a loop is the right shape.
