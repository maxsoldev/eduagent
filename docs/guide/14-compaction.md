# 14 — Context management and compaction

## Concept

### The context window fills up

Every request sends the *whole* conversation again (chapter 02). Each tool output, file read and reasoning item makes the next request bigger. A model can only read so many tokens at once. This limit is its **context window**. For `gpt-6-luna` in Codex's `models.json` it is 272,000 tokens.

A coding agent hits this limit faster than you would expect. One `cat` of a big file or one long test log can add 10k tokens. A turn with 50 tool calls can fill the window before the model has finished.

If we do nothing, the API rejects the request and the session is stuck. The harness has to notice early and make room.

### Step 1: know how full the window is

The harness needs a token count before every request. There are two sources:

1. **The API's own count.** Each `response.completed` event carries `usage`:
   ```json
   {"input_tokens": 41210, "output_tokens": 812, "total_tokens": 42022}
   ```
   `total_tokens` is exact, but it only covers what the model has *already seen*.
2. **An estimate** for items added since then, such as the tool outputs we are about to send. Codex uses a simple rule: about 4 bytes per token.

So: `tokens in context ≈ last usage.total_tokens + estimate(items added after it)`.

### Step 2: decide when to act

Codex compacts at the **auto-compact limit**:

```
auto_compact_limit = min(model's auto_compact_token_limit, 90% of context_window)
```

For a 272k window with no configured limit, that is 244,800 tokens. The 10% gap leaves room for the model's reply and for estimation errors.

There are two places in the loop (chapter 04) where the check runs:

| When | Why |
|---|---|
| **Pre-turn**: before the new user message is added | The previous turn left the history already over the limit |
| **Mid-turn**: after a model call that asked for tools | The model still has work to do, and the next request would be too big |

If the model just answered (no tool calls), the turn ends and nothing is compacted. The next turn's pre-turn check handles it.

### Step 3: compact (summarise and replace)

**Compaction** replaces a long history with a short one that still lets the model continue. The local version has two steps:

**(a) Ask for a summary.** Send the whole history plus one extra user message, with **no tools**:

```text
You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue
...
```

The model replies with a normal assistant message: the summary.

**(b) Build the replacement history.** Throw away the old list and build a new one:

```
[developer] <permissions instructions>…            ┐ fresh context, built again from
[user]      # AGENTS.md … / <environment_context>  ┘ the current config
[user]      "add a --verbose flag"                 ← older real user messages (≤ 20k tokens total)
[user]      "now also update the README"           ← the last real user message
[user]      Another language model started to solve this problem and produced a
            summary of its thinking process. … <the summary>
```

Three rules to notice:
- **Only real user messages are kept.** Tool calls, outputs and assistant messages are gone; the summary stands in for them. What the user asked for is the most important thing not to lose, so those messages are kept word for word, newest first, until a 20k-token budget runs out. The oldest one that does not fit is cut in the middle, not dropped.
- **Context is rebuilt, not copied.** The permissions, AGENTS.md and environment messages are generated again from the current settings. Codex puts them right before the last real user message.
- **The summary goes last**, behind a fixed prefix (`summary_prefix.md`). The prefix tells the model that the text came from "another language model". It also lets the harness recognise old summaries later, so it does not keep them as "user messages" in the next compaction.

After this, the loop simply continues. The next request is small again.

### Local vs remote compaction

What we just described is **local** compaction: the summary is plain text, made by an ordinary request. OpenAI's API can do better. With **remote** compaction, the server returns a special item instead of a text summary:

```json
{"type": "compaction", "encrypted_content": "gAAAAB..."}
```

It is opaque, like encrypted reasoning (chapter 08). The [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/) post says it "preserves the model's latent understanding of the original conversation". The harness keeps some recent messages and puts this item at the end of the new history.

## In educodex

All of it is in [`compact.py`](../../src/educodex/compact.py) (under 100 lines), with the token count in [`history.py`](../../src/educodex/history.py) and the limit in [`models.py`](../../src/educodex/models.py).

**Counting tokens.** `History` remembers how long the list was when the last `usage` arrived. Anything after that is estimated:

```python
def token_count(self) -> int:
    if self.last_usage:
        return self.last_usage.get("total_tokens", 0) + sum(approx_tokens(i) for i in self.items[self._usage_at :])
    return sum(approx_tokens(i) for i in self.items)
```

**The limit** ([`models.py`](../../src/educodex/models.py)):

```python
def effective_auto_compact_limit(self) -> int:
    ninety_percent = self.context_window * 9 // 10
    if self.auto_compact_token_limit is None:
        return ninety_percent
    return min(self.auto_compact_token_limit, ninety_percent)
```

**The two triggers** in [`turn.py`](../../src/educodex/turn.py):

```python
# pre-turn, before the user's message is recorded
if session.history.token_count() >= session.model_info.effective_auto_compact_limit():
    await compact.run_compact(ctx, reason="pre-turn")
...
# mid-turn, after each model call
if needs_follow_up and tokens >= limit:
    await compact.run_compact(ctx, reason="auto")
    continue
```

**The replacement history** (`build_compacted_history`): newest user messages first, until the 20k budget runs out, then the fresh context before the last one, then the summary:

```python
for item in reversed(users):  # newest first, until the budget runs out
    if remaining <= 0:
        break
    ...
    if tokens > remaining:  # the oldest one that does not fit is truncated, not dropped
        item = user_message(truncate_middle(text, remaining)[0])
    kept.insert(0, item)
    remaining -= tokens
new_history = kept[:-1] + context + kept[-1:]
new_history.append(user_message(f"{summary_prefix()}\n{summary or '(no summary available)'}"))
```

`is_real_user_message` skips injected context (`<environment_context>`, AGENTS.md, permissions), `<turn_aborted>` markers and earlier summaries.

`run_compact` ties it together. It shows up in every client:
- a `contextCompaction` item (`item/started` / `item/completed`) and a `thread/compacted` notification;
- `trace/compactionRequest` with the exact request body, and `trace/compacted` with token counts before and after plus the whole new history;
- a `compacted` line in the rollout file with `message` and `replacement_history`, the same fields Codex writes. Replay uses it to rebuild history (chapter 15).

**Manual compaction.** The web UI's **compact** button calls `thread/compact/start` ([`app_server/processor.py`](../../src/educodex/app_server/processor.py)). Like Codex, the server replies `{}` right away. `Session.start_compaction` then runs `run_compact(ctx, reason="manual")` as the session's task, the same slot a turn uses, so a compaction and a turn can never overlap. It is refused while a turn is running. Progress arrives as `item/started` / `item/completed` for the `contextCompaction` item.

**Remote compaction, for reference.** The module docstring describes what Codex does instead: a normal `/responses` request whose input ends in a `compaction_trigger` item, answered with one encrypted `compaction` item. The older `/responses/compact` endpoint is gone.

## In Codex

- **The limit:** [`ModelInfo::auto_compact_token_limit`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/openai_models.rs#L527) takes `min(configured, 90% of window)`. [`context_window_token_status_with_config`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/context_window.rs#L53) also forces compaction at a hard cap, `effective_context_window_percent` (default 95%) of the window.
- **Counting tokens:** [`get_total_token_usage`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/context_manager/history.rs#L934) is the last `total_tokens` plus an estimate for items after the last model-generated item. The estimate is [`approx_token_count`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/utils/string/src/truncate.rs#L101): bytes / 4, rounded up.
- **Triggers:** [`run_pre_sampling_compact`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/turn.rs#L1303) (pre-turn) and [`should_roll_over`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/turn.rs#L608) (mid-turn, only when `needs_follow_up`). [`run_auto_compact`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/turn.rs#L1472) then picks remote or local compaction based on what the provider supports.
- **Local compaction:** [`core/src/compact.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/compact.rs#L63) (`COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`). The summary request is in [`run_compact_task_inner_impl`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/compact.rs#L259). If even the compaction request is too big, it [drops the oldest item and retries](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/compact.rs#L344). History building is in [`build_compacted_history_with_limit`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/compact.rs#L686), and context placement in [`insert_initial_context_before_last_real_user_or_summary`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/compact.rs#L615).
- **Prompts:** [`prompts/templates/compact/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/prompts/templates/compact) (`prompt.md`, `summary_prefix.md`), the same files educodex vendors.
- **Remote compaction:** [`core/src/compact_remote_v2.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/compact_remote_v2.rs#L430). At this commit it no longer calls `/responses/compact`. That legacy endpoint client was removed in PR #44273. Instead, Codex sends a normal `/responses` request whose input ends with a [`{"type": "compaction_trigger"}`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/compact_remote_v2_attempt.rs#L95) item, and expects exactly one [`compaction`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/models.rs#L1230) item (`encrypted_content`) back. It keeps up to 64k tokens of recent messages. It is on by default for OpenAI and Azure providers ([`capabilities.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/model-provider/src/capabilities.rs#L33)); everything else uses local compaction.
- **Manual:** [`thread/compact/start`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/protocol/common.rs#L734) submits `Op::Compact` ([`thread_processor.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server/src/request_processors/thread_processor.rs#L2370)) and returns `{}` right away. Progress then arrives as notifications.

## Where educodex is simpler

- **Local only.** OpenRouter has no compaction trigger, so we always summarise in plain text. That is actually useful for teaching: you can read the summary.
- **No hard cap.** We check only the 90% limit, not Codex's separate 95% cap, and there is no token-budget mode or post-turn compaction.
- **No retries.** If the summary request fails or is itself too long, the turn fails. Codex retries with backoff and trims the oldest items.
- **Deprecated notification kept.** We still send `thread/compacted`, which Codex marks as deprecated in favour of the `contextCompaction` item.
- **No pre/post-compact hooks** and no compaction analytics.
- **Rough estimates.** We estimate an item from its JSON size. Codex counts only model-visible bytes and treats images and reasoning separately.

## Try it

1. Start the server and open http://127.0.0.1:8765 (build the UI first: `cd web && pnpm install && pnpm build`):
   ```bash
   uv run educodex app-server
   ```
2. Have a short conversation, then press **compact**. In the **Timeline**, click *Compaction request*: it is the full history plus the summary prompt, with `"tools": []`. Then click *History compacted* and read `newHistory`.
3. Open the **Context** tab and untick *zoom to used*. The bar now spans the whole context window, with a marker at the auto-compact limit. After compaction you will see the "compaction summary" item at the end.
4. Offline, over stdio. The fake model returns the next scripted response as the "summary", so a two-response script is enough:
   ```bash
   echo '[[{"type":"message","text":"Hi!"}],[{"type":"message","text":"## Progress\n- greeted"}]]' > /tmp/compact.json
   uv run educodex app-server --listen stdio:// --fake-model /tmp/compact.json
   ```
   Paste `initialize`, `initialized`, `thread/start` and a `turn/start` with the text `hello` (see chapter 16), then `{"id":9,"method":"thread/compact/start","params":{"threadId":"<id>"}}`. The reply is `{"id":9,"result":{}}`, sent before the compaction finishes. Then look for `trace/compacted`: the new history is the fresh context (a developer message with permissions, an `<environment_context>` user message), `"hello"`, then the summary.

## Further reading
- [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/): the "context window" section explains `/compact`, auto-compaction and the encrypted `compaction` item.
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents): compaction, note-taking and sub-agents as ways to manage context.
- [Context Engineering for AI Agents: Lessons from Building Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus): why you should keep errors in context and use the file system as memory.
- [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents): working across many context windows.
