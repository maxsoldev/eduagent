# 07 — Compaction

Read [educodex chapter 15, Context management and compaction](../educodex/15-compaction.md) first. It explains why the context window fills up and what compaction is. This chapter shows how pi does it: when it compacts, what it keeps, how it writes the summary, and how the next request is built from the session file.

## Concept

### When pi compacts: three triggers

pi compacts for three reasons. Each `compaction_start` and `compaction_end` event names its `reason`:

| Reason | When | Then |
|---|---|---|
| `manual` | The user sends `compact` (pi's `/compact`), with optional custom instructions | No retry |
| `threshold` | The context is above **context window − reserve tokens** | No retry. Inside a run, the next turn starts from the compacted context |
| `overflow` | The provider refused the request: the context is too long | Compact, then **retry the turn once** |

**The threshold rule** is one line ([`shouldCompact`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/compaction/compaction.ts#L267)):

```ts
return contextTokens > contextWindow - settings.reserveTokens;
```

`reserveTokens` is 16,384 by default. It is the room left for the model's reply. For a 272,000-token window, pi compacts above 255,616 tokens. The context size is the `totalTokens` of the last reply's usage, as the provider reported it. If that reply failed or reports no usage, pi estimates: the last good usage, plus characters / 4 for every message after it.

The window comes from the model's metadata. edupi reads it from OpenRouter's `GET /models` list when it starts (chapter 01).

pi checks the threshold at these points:

- **after each run**, after `agent_end` and before `agent_settled`;
- **before each prompt**, before the user message is added (the previous run may have ended above the threshold, for example if it was aborted);
- **before each later model call inside a run**, after tool results: one big tool output can fill the window in the middle of a run. The agent loop calls the session's `prepareNextTurn` hook before each later turn.

**The overflow rule.** The provider answers with an error, for example OpenRouter's HTTP 400 `This endpoint's maximum context length is 128000 tokens. However, you requested about 140000 tokens.` Every provider says this in its own words, so pi matches the error text against a list of patterns ([`overflow.ts`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/utils/overflow.ts#L38)). Then pi:

1. writes a `context_edit` entry with `replacement: null` for the failed reply. The reply stays in the file, but it is no longer part of the context;
2. compacts, with `reason: "overflow"`. `compaction_end` has `willRetry: true`. The user message that overflowed goes into the summary too (see the cut point below), so the retry does not send it again;
3. continues the run (`agent.continue()`): a new `agent_start`, and the model answers from the smaller context.

It does this once per user message. If the retry overflows again, pi stops with `Context overflow recovery failed after one compact-and-retry attempt. …`

### What pi keeps: the cut point

Codex keeps the user messages and throws away everything else. pi keeps the **newest part of the conversation word for word**, and summarises the rest.

`keepRecentTokens` (20,000 by default) sets how much is kept. pi walks back from the newest message and adds up estimated tokens (characters / 4). When the sum reaches `keepRecentTokens`, it cuts at the nearest user or assistant message at or after that point. It never cuts at a tool result, because a tool result must follow its tool call.

```
q1  A1  q2  A2(tool call)  result  A3     ← newest
                └──────── kept ────────┘
└─ summarised ─┘
```

If the cut is at an assistant message, it splits a **turn** (a user message and the replies after it). pi then makes two summary requests: one for the history before the turn, and one for the first part of the turn (the **turn prefix**). It joins them:

```
<history summary>

---

**Turn Context (split turn):**

<turn prefix summary>
```

**After an overflow**, only the omitted failed reply (and its `context_edit`) follows the last user message. If the walk back reached `keepRecentTokens` there, pi moves the cut one entry on, to the omitted reply ([`findProjectedCutPoint`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/compaction/compaction.ts#L818)). The user message is then the prefix of a split turn and is summarised: a big prompt that caused the overflow does not cause it again.

If there is nothing older than the cut, there is nothing to summarise. A manual `compact` then fails with `Nothing to compact (session too small)`. An automatic compaction stops **without any event**. This is why a quick test with tiny messages does not trigger threshold compaction: with `keepRecentTokens: 10`, the walk back reached 10 tokens only at the first user message, so the cut kept everything. Use longer messages, or a lower `keepRecentTokens`.

### How pi writes the summary

The summary request has no tools and no conversation messages. It is one system message and one user message ([`generateSummaryWithUsage`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/compaction/compaction.ts#L696)):

```
[system] You are a context summarization assistant. … Do NOT continue the conversation. …
[user]   <conversation>
         [User]: add a --verbose flag
         [Assistant]: I will read the CLI first.
         [Assistant tool calls]: read(path="src/cli.ts")
         [Tool result]: …
         </conversation>

         The messages above are a conversation to summarize. Create a structured context
         checkpoint summary that another LLM will use to continue the work.

         Use this EXACT format:

         ## Goal
         ## Constraints & Preferences
         ## Progress (### Done, ### In Progress, ### Blocked)
         ## Key Decisions
         ## Next Steps
         ## Critical Context
         …
         Additional focus: <custom instructions, if any>
```

Three details:

- **The conversation is plain text.** [`serializeConversation`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/compaction/utils.ts#L120) writes `[User]:`, `[Assistant]:`, `[Assistant tool calls]:` and `[Tool result]:` lines. As real messages, the model could take the conversation as its own and continue it. Tool results are cut to 2,000 characters. Thinking is left out.
- **Later compactions update the summary.** If there was an earlier compaction, pi sends only the messages after it, plus the old summary in `<previous-summary>` tags, with the **update prompt**: `The messages above are NEW conversation messages to incorporate into the existing summary … PRESERVE all existing information …`. So the summary grows over the session, and the old messages are never summarised twice.
- **File lists are added by pi, not by the model.** pi collects the `path` of every `read`, `write` and `edit` tool call (and the lists of the earlier compaction) and appends them to the summary as `<read-files>` and `<modified-files>`. They are also in the entry's `details`.

### The compaction entry and the next request

pi writes the result as a `compaction` entry in the session file (chapter 06):

```json
{"type":"compaction","id":"af442afc","parentId":"57216692","summary":"## Goal\n…","firstKeptEntryId":"a8aa2287",
 "tokensBefore":120,"details":{"readFiles":[],"modifiedFiles":[]},"usage":{…},"systemMessage":{"role":"system",…}}
```

The kept messages are **not copied**. `firstKeptEntryId` points at the first kept entry, which is already in the file. The entry also stores the current system message, because the rebuilt context leaves out the older system messages.

Then pi rebuilds the agent's messages from the file (`_refreshFinalizedContext`), with the rule of chapter 06. The next request is:

```
[system]    the system prompt, from the compaction entry's systemMessage
[user]      The conversation history before this point was compacted into the following summary:
            <summary>
            ## Goal …
            </summary>
[user]      q2                       ┐ the kept messages, from firstKeptEntryId on
[assistant] Second answer …          ┘
[user]      q3                       ← the new prompt
```

The summary goes to the model as a **user** message at the **start**, before the kept messages. In the session it is pi's own `compactionSummary` role; `convertToLlm` turns it into the user message just before the call.

## In edupi

| File | What it does |
|---|---|
| [`core/compaction/compaction.ts`](../../../backends/edupi/src/coding-agent/core/compaction/compaction.ts) | Token counts and estimates, `shouldCompact`, the cut point, `prepareCompaction`, pi's three prompts (copied unchanged), `compact` |
| [`core/compaction/utils.ts`](../../../backends/edupi/src/coding-agent/core/compaction/utils.ts) | File lists, `serializeConversation`, the summarizer's system prompt |
| [`core/agent-session.ts`](../../../backends/edupi/src/coding-agent/core/agent-session.ts) | When: `compact` (manual), `_checkCompaction` (threshold and overflow), `_runAutoCompaction`, the retry loop in `_startRun`, `_omitRecoveryAttempt` |
| [`core/session-manager.ts`](../../../backends/edupi/src/coding-agent/core/session-manager.ts) | `appendCompaction`, `appendContextEdit`, `buildSessionProjection` (the context after edits) |
| [`core/settings-manager.ts`](../../../backends/edupi/src/coding-agent/core/settings-manager.ts) | `compaction` settings from `<home>/settings.json` |
| [`ai/utils/overflow.ts`](../../../backends/edupi/src/ai/utils/overflow.ts) | pi's overflow patterns |
| [`agent/agent.ts`](../../../backends/edupi/src/agent/agent.ts), [`agent/agent-loop.ts`](../../../backends/edupi/src/agent/agent-loop.ts) | `continue()`: run the loop again without a new message (the overflow retry); the `prepareNextTurn` hook before each later turn (the check inside a run) |

The run with its two checks, from `AgentSession._startRun`:

```ts
messages = await this._prepareRun(text, images);   // threshold check before the prompt
onStarted?.();                                     // the "prompt" response
try {
  await this.agent.prompt(messages);
  while (await this._handlePostAgentRun()) await this.agent.continue();   // true only for an overflow retry
} finally {
  this._emitAgentSettled();
}
```

The settings are pi's, in `~/.eduagent/.edupi/agent/settings.json`:

```json
{ "compaction": { "enabled": true, "reserveTokens": 16384, "keepRecentTokens": 20000 } }
```

**Trace events.** edupi adds two of the shared trace events (protocol spec, section 6). `compactionRequest` (`reason`, `tokensBefore`, `body`) carries the exact body of each summary request. It is sent from pi's own hook for request bodies, `onPayload`, which the summary call passes to the provider. The provider then sends its usual `modelRequest`, `streamEvent`s and `modelResponse`. `compacted` (`reason`, `summary`, `firstKeptEntryId`, `tokensBefore`, `tokensAfter`, `details`, `messages`) comes once the entry is saved; `messages` is the context rebuilt from it.

**Tests.** `test/rpc-compaction.test.ts` (seam A) runs all three triggers with the faux provider, and the threshold both after a run and inside one (a big bash output). One test replays the session real pi recorded (`test/fixtures/pi/session-compact.jsonl`): the same settings, prompts and replies give the same summary requests as real pi sent, byte for byte, and the same compaction entries. The faux provider plays a context overflow with an error step, `{"error": {"status": 400, "message": "…maximum context length is 1000 tokens…"}}`, and a small context window with a `models` list.

## In pi

- The pure functions: [`compaction.ts`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/compaction/compaction.ts): [`DEFAULT_COMPACTION_SETTINGS`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/compaction/compaction.ts#L126), [`estimateContextTokens`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/compaction/compaction.ts#L196), [`estimateTokens`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/compaction/compaction.ts#L298), [`SUMMARIZATION_PROMPT`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/compaction/compaction.ts#L507) and the [update prompt](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/compaction/compaction.ts#L577), [`findProjectedCutPoint`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/compaction/compaction.ts#L789), [`prepareCompaction`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/compaction/compaction.ts#L859), [the turn-prefix prompt](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/compaction/compaction.ts#L929), [`compact`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/compaction/compaction.ts#L952); and [`utils.ts`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/compaction/utils.ts#L120).
- When it runs, in [`agent-session.ts`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/agent-session.ts): [`compact`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/agent-session.ts#L2794) (manual), [`_checkCompaction`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/agent-session.ts#L2977), [`_runAutoCompaction`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/agent-session.ts#L3127), the check points [`_prepareRun`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/agent-session.ts#L1890), [`_handlePostAgentRun`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/agent-session.ts#L1943) and [`_compactBeforeNextAssistantResponse`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/agent-session.ts#L777), and [`_omitRecoveryAttempt`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/agent-session.ts#L1241).
- The session side: [`appendCompaction`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/session-manager.ts#L1261), [`appendContextEdit`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/session-manager.ts#L1360), [`buildSessionProjection`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/session-manager.ts#L543).
- Overflow detection: [`isContextOverflow`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/utils/overflow.ts#L142).
- pi's own docs: [`docs/compaction.md`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/docs/compaction.md).

## How Codex does it differently

| | pi (edupi) | Codex (educodex) |
|---|---|---|
| Threshold | window − `reserveTokens` (16,384) | 90% of the window, or the model's `auto_compact_token_limit` ([chapter 15](../educodex/15-compaction.md)) |
| Check points | before a prompt, after a run, before later model calls in a run | pre-turn, and mid-turn after a model call that asked for tools |
| Overflow error | detected; drop the failed reply, compact, retry once | the turn fails; Codex marks the window as full ([`set_total_tokens_full`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/turn.rs#L1688)), so the next turn compacts first |
| What is kept | the newest messages word for word, about `keepRecentTokens`, cut at a user or assistant message | only real user messages (up to 20k tokens); assistant messages and tool calls are gone |
| Summary request | the old messages as **plain text** in one user message, with pi's checkpoint prompt | the **whole history** as real items, plus one user message with the compaction prompt |
| Later compactions | **update** the previous summary with only the new messages | summarise the whole (already compacted) history again |
| Where the summary goes | first, as a user message (`compactionSummary` role) | last, behind a fixed prefix (`summary_prefix.md`) |
| File lists | added by pi from tool calls (`<read-files>`, `<modified-files>`) | none |
| Custom instructions | `compact` with `customInstructions` ("Additional focus: …") | none for `thread/compact/start` |
| Stored | a `compaction` entry: summary + `firstKeptEntryId`; the old entries stay in the file | a `compacted` rollout line with the whole `replacement_history` |
| Remote compaction | none: always a text summary | an encrypted `compaction` item for OpenAI providers |

The biggest difference is **what survives**. Codex bets that the user's own words plus a summary are enough: everything the agent did is replaced by the summary. pi keeps the recent work itself, tool calls and results included, so the model can go on with exact text in front of it. The price is that the kept part takes up to `keepRecentTokens` of the new context.

## Where edupi is simpler

- **No extensions.** pi lets an extension cancel a compaction or supply its own summary (`session_before_compact`, `fromHook`). edupi always uses pi's built-in summary.
- **Fewer message kinds.** edupi has no `bashExecution`, `custom` or `branchSummary` messages, no codemode nested calls and no branch summaries (`branch-summarization.ts`), so token estimates, cut points and file lists only know user, assistant, tool result and compaction summary messages.
- **No summary retries.** pi retries a summary call after a transient network error (`retryAssistantCall`). edupi fails the compaction.
- **Global settings only.** pi also reads `<cwd>/.pi/settings.json` once the project is trusted, and has per-model overrides (`compaction.modelOverrides`) and `set_auto_compaction`. edupi reads `<home>/settings.json`.
- **Simpler overflow bookkeeping.** pi checks that the failed reply is still part of the context and has more cases for omissions of omissions. edupi omits the failed reply and its tool results.
- **Entry order, not timestamps.** A reply is "from before the latest compaction" (its usage is stale) if its entry comes before the compaction entry in the session file. pi compares millisecond timestamps; with the fast faux provider both can fall in the same millisecond. A message with no entry yet falls back to pi's timestamp rule.

## Try it

**In the visualiser.** Open **edupi** (or **edupi-faux**). Compaction needs history older than `keepRecentTokens`, so first lower it:

```bash
echo '{"compaction":{"keepRecentTokens":10}}' > ~/.eduagent/.edupi/agent/settings.json
```

Chat two or three turns, then type `/compact Keep the file names.` The chat shows *context compacted (manual)*. In the **Timeline**, click *Compaction request*: read the serialised conversation and the checkpoint prompt with your instructions at the end. Click *Context compacted* and read `messages`: the summary first, then the kept messages. Then compact a second time after one more turn: the request now has `<previous-summary>` and the update prompt. Remove the settings file when you are done.

**Offline, over stdio.** Watch the threshold trigger with a tiny context window from the faux model list. The window is 200 tokens and the reserve 150, so pi compacts above 50 tokens. `keepRecentTokens` 31 keeps the second prompt (2 estimated tokens) and its answer (30):

```bash
export EDUPI_CODING_AGENT_DIR=/tmp/edupi-home/agent && mkdir -p $EDUPI_CODING_AGENT_DIR
echo '{"compaction":{"reserveTokens":150,"keepRecentTokens":31}}' > $EDUPI_CODING_AGENT_DIR/settings.json
cat > /tmp/tiny.json <<'EOF'
{ "models": [{ "id": "openai/gpt-6-luna", "context_length": 200, "top_provider": { "max_completion_tokens": 50 } }],
  "responses": ["Short answer.", "A much longer answer that fills the tiny context window of this model, so that the next check goes above the threshold.", "## Goal\nTest the threshold."] }
EOF
node bin/edupi.mjs --mode rpc --faux /tmp/tiny.json
{"id":"1","type":"prompt","message":"first"}
{"id":"2","type":"prompt","message":"second"}
```

After the second run, `compaction_start` with `reason: "threshold"` comes between `agent_end` and `agent_settled`. Set `keepRecentTokens` to `20000` and try again: nothing happens, not even an event, because the cut keeps everything.

For the overflow trigger, set `keepRecentTokens` to `1` (so the old turn is summarised), and use these responses:

```json
{ "responses": ["Short answer.",
  {"error": {"status": 400, "message": "This endpoint's maximum context length is 1000 tokens. However, you requested about 5000 tokens."}},
  "## Goal\nRecover.", "## Original Request\nsecond", "After the retry."] }
```

The second prompt fails. Look for the `entry_appended` event with the `context_edit`, then two summary requests (the old turn, then the turn prefix with the second prompt), `compaction_end` with `willRetry: true`, and the second `agent_start`, whose reply is "After the retry."

Run the tests:

```bash
npx vitest run test/rpc-compaction.test.ts
```

## Further reading

- pi's [`docs/compaction.md`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/docs/compaction.md): the settings and the extension hooks.
- [educodex chapter 15](../educodex/15-compaction.md): Codex's local and remote compaction.
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents): compaction among other ways to manage context.
- [Context Engineering for AI Agents: Lessons from Building Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus): why keeping recent actions and errors word for word helps the model.
