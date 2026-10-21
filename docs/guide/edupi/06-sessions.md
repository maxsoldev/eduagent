# 06 — Sessions

Read [educodex chapter 16, Session logs](../educodex/16-session-logs.md) first. It explains why a harness writes each session to a file, and how Codex's rollout files work. This chapter shows pi's session files, which edupi writes in the same format, and how they differ from rollouts.

## Concept

### A session is a tree of entries

pi also writes each session as JSONL, one JSON object per line, appended as things happen. But the lines are not a log of events. Line 1 is a **header**. Every other line is an **entry** with an `id` and a `parentId`:

```
{"type":"session","version":3,"id":"01a15f55-8f1e-77f7-8f72-49d187f11704","timestamp":"2026-10-21T16:40:05.151Z","cwd":"/private/tmp/eduagent-pi-record/session-prompt-and-tools/cwd"}
{"type":"model_change","id":"d7552282","parentId":null,"timestamp":"…","provider":"fake","modelId":"openai/gpt-6-luna"}
{"type":"thinking_level_change","id":"d9eebecc","parentId":"d7552282","timestamp":"…","thinkingLevel":"medium"}
{"type":"message","id":"1f667c8e","parentId":"d9eebecc","timestamp":"…","message":{"role":"system","content":"","sections":{"preamble":"You are an expert coding assistant operating inside pi, …","tools":"<tools>…</tools>",…},"toolsAdded":[…]}}
{"type":"message","id":"bb044752","parentId":"1f667c8e","timestamp":"…","message":{"role":"user","content":[{"type":"text","text":"say hi"}],"timestamp":1792600805183}}
{"type":"message","id":"fd2d1e33","parentId":"bb044752","timestamp":"…","message":{"role":"assistant","content":[{"type":"text","text":"Hello from fake."}],"provider":"fake","model":"openai/gpt-6-luna","usage":{…},"stopReason":"stop",…}}
```

(A real file written by pi at the pinned commit, shortened. It is `test/fixtures/pi/session-prompt-and-tools.jsonl`.)

The `parentId` links make the entries a **tree**. An entry is appended as a child of the current **leaf**, and the leaf moves to it. pi can move the leaf back to an earlier entry and continue from there: the old continuation stays in the file as a side branch. That is how pi's `/tree`, fork and clone work, all in one file. edupi writes one linear branch: each entry's parent is the entry before it.

| `type` | What it holds |
|---|---|
| `session` (header) | `version` (3), session `id` (a UUIDv7, so ids sort by time), `timestamp`, `cwd` |
| `message` | One message, in the same shape as the RPC events: `system`, `user`, `assistant` or `toolResult` |
| `model_change` | `provider` and `modelId` |
| `thinking_level_change` | `thinkingLevel` |
| `compaction` | `summary`, `firstKeptEntryId`, `tokensBefore`, and the `systemMessage` at that point (chapter 07) |
| `context_edit` | `targetId` and `replacement`; `null` leaves the target entry out of the context (chapter 07) |

Entry ids are 8 hex characters, checked for collisions in the file. pi has more entry types (labels, branch summaries, extension data). edupi reads and writes the ones above, plus `context_edit` (chapter 07).

### The context is rebuilt from the entries

pi does not store "the history the model sees". It rebuilds it from the entries, every time it needs it (`buildSessionContext`):

1. Walk from the leaf up through the `parentId` links to the root, then reverse. This is the current **path**.
2. If the path has no compaction, every `message` entry on it gives its message.
3. If it has compactions, only the **latest** counts. The context is its `systemMessage` and a `compactionSummary` message, then the entries from `firstKeptEntryId` up to the compaction (their own system messages left out), then every entry after it.
4. The settings come from the same path: the last `thinking_level_change`, and the model from the last `model_change` or assistant message.

The `compactionSummary` message is pi's own role. Just before each model call, `convertToLlm` turns it into a user message:

```
The conversation history before this point was compacted into the following summary:

<summary>
## Goal
…
</summary>
```

The system prompt is in the file too, as a `system` message. pi keeps it inside the transcript (chapter 03), so a session file holds everything the model saw.

### Where the files go

```
~/.pi/agent/sessions/--Users-max-proj--/2026-10-21T16-40-05-151Z_01a15f55-8f1e-77f7-8f72-49d187f11704.jsonl
         └ agent dir┘ └─ one folder per cwd ┘└──── start time, UTC ───┘ └──────── session id ────────────────┘
```

The folder name is the working directory, with the first `/` dropped, the other `/`, `\` and `:` replaced by `-`, and `--` on both sides. So all sessions of one project are in one folder, and `pi --continue` only has to look at the newest file there.

edupi's home is `~/.eduagent/.edupi/agent`, with the same inner layout, so it never touches a real pi's files. `EDUPI_CODING_AGENT_DIR` overrides it, as `PI_CODING_AGENT_DIR` does for pi. The tests set it to a temporary folder.

### The file is written late

A new session's first entries (the model and the thinking level) stay in memory. pi creates the file only when the first user or assistant message is appended. Then it writes all entries so far, and after that it appends one line per entry. Opening and closing pi without chatting leaves no file. `get_state` names the `sessionFile` from the start, but the file may not exist yet.

### Messages are saved when they end

The session subscribes to the agent's events. On each `message_end` it appends a `message` entry. So a streaming reply is not in the file until it is complete, and a crash loses at most the message in progress.

### new_session and get_messages

An RPC process holds one session. Two commands work on it:

- **`new_session`** does not clear the old session. pi builds a new session manager (a new file in the same folder) and a new `AgentSession` around it, and RPC mode subscribes to the new one. The old file stays as it was. The response is `{"cancelled": false}` (an extension can cancel the switch). No event announces the new session; the client calls `get_state` after it.
- **`get_messages`** returns the session's current messages: the context rebuilt from the entries, plus what the current run added. After a compaction it starts with the system message and the `compactionSummary`. A client that connects to a session already in progress can use it to show the conversation.

### Opening a session

pi starts with a new session unless told otherwise:

| Flag | Session |
|---|---|
| (none) | a new session in the cwd's folder |
| `--session <file>` | that file; its `cwd` comes from the header |
| `--continue`, `-c` | the newest file in the cwd's folder, or a new session |
| `--no-session` | in memory only; `get_state` has no `sessionFile` |

When a file already has messages, the agent starts from its rebuilt context, with the session's thinking level (clamped to what the model supports) and, if pi knows it, the session's model. New entries are appended to the same file, as children of its last entry.

## In edupi

| File | Mirrors (pi) | What it does |
|---|---|---|
| [`src/coding-agent/core/session-manager.ts`](../../../backends/edupi/src/coding-agent/core/session-manager.ts) | `core/session-manager.ts` | Entry types, `buildContextEntries`, `buildSessionContext`, the session folder, `SessionManager` (`create`, `open`, `continueRecent`, `inMemory`, the late write) |
| [`src/coding-agent/core/messages.ts`](../../../backends/edupi/src/coding-agent/core/messages.ts) | `core/messages.ts` | The `compactionSummary` role and `convertToLlm` |
| [`src/coding-agent/config.ts`](../../../backends/edupi/src/coding-agent/config.ts) | `config.ts` | `getAgentDir` (`~/.eduagent/.edupi/agent`, `EDUPI_CODING_AGENT_DIR`) |
| [`src/coding-agent/core/sdk.ts`](../../../backends/edupi/src/coding-agent/core/sdk.ts) | `core/sdk.ts` | `createAgentSession`: restore the context and settings, or record the settings of a new session |
| [`src/coding-agent/core/agent-session-runtime.ts`](../../../backends/edupi/src/coding-agent/core/agent-session-runtime.ts) | `core/agent-session-runtime.ts` | `newSession`: a new session manager and a new `AgentSession` |
| [`src/coding-agent/core/agent-session.ts`](../../../backends/edupi/src/coding-agent/core/agent-session.ts) | `core/agent-session.ts` | `_handleAgentEvent` appends each finished message; `sessionFile`, `sessionId` |
| [`src/coding-agent/modes/rpc/rpc-mode.ts`](../../../backends/edupi/src/coding-agent/modes/rpc/rpc-mode.ts) | `modes/rpc/rpc-mode.ts` | `new_session` (then `rebindSession`), `get_messages` |
| [`src/ai/utils/uuid.ts`](../../../backends/edupi/src/ai/utils/uuid.ts) | `ai/src/utils/uuid.ts` | `uuidv7` for session ids |

The context rule, in edupi's code:

```ts
export function buildContextEntries(entries: SessionEntry[], leafId?: string | null): SessionEntry[] {
  const path = buildSessionPath(entries, leafId);
  let compaction: CompactionEntry | undefined;
  for (const entry of path) if (entry.type === "compaction") compaction = entry;
  if (!compaction) return path;

  const compactionIdx = path.indexOf(compaction);
  const contextEntries: SessionEntry[] = [compaction];
  let foundFirstKept = false;
  for (let i = 0; i < compactionIdx; i++) {
    const entry = path[i];
    if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
    if (foundFirstKept && !(entry.type === "message" && entry.message.role === "system")) contextEntries.push(entry);
  }
  contextEntries.push(...path.slice(compactionIdx + 1));
  return contextEntries;
}
```

The tests in [`test/rpc-session.test.ts`](../../../backends/edupi/test/rpc-session.test.ts) check the written file against pi's format, `new_session`, `get_messages`, `--continue` and `--no-session`. Two tests open files written by the real pi ([`test/fixtures/pi/`](../../../backends/edupi/test/fixtures/pi/), recorded by `visualiser/test/record-pi.mjs`). One has two compactions; its test checks that edupi's next request is the request the real pi sent, plus the new turn.

## In pi

- The file format: [`SessionHeader`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/session-manager.ts#L43), [`SessionEntryBase`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/session-manager.ts#L57), [`CompactionEntry`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/session-manager.ts#L91), [`generateId`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/session-manager.ts#L277), and pi's own [`docs/session-format.md`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/docs/session-format.md).
- The rebuild: [`buildSessionPath`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/session-manager.ts#L390), [`getSessionContextSettings`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/session-manager.ts#L418), [`sessionEntryToContextMessages`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/session-manager.ts#L439), [`buildContextEntries`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/session-manager.ts#L476), [`buildSessionProjection`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/session-manager.ts#L543), and the summary message in [`messages.ts`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/messages.ts#L11) ([`convertToLlm`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/messages.ts#L148)).
- The class: [`SessionManager`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/session-manager.ts#L987), [`newSession`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/session-manager.ts#L1057), the late write in [`_hasConversation` and `_persist`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/session-manager.ts#L1166), [`appendMessage`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/session-manager.ts#L1204), and the constructors [`create`, `open`, `continueRecent`, `inMemory`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/session-manager.ts#L1755).
- The folder: [`getDefaultSessionDirPath`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/session-manager.ts#L589), [`findMostRecentSession`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/session-manager.ts#L749), [`ENV_AGENT_DIR` and `getAgentDir`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/config.ts#L585).
- Saving and restoring: [the persistence in `_handleAgentEvent`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/agent-session.ts#L1147), [`createAgentSession`'s restore](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/sdk.ts#L210) and [its new-session entries](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/sdk.ts#L448), [`createSessionManager`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/main.ts#L358) for the flags.
- The commands: [`AgentSessionRuntime.newSession`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/agent-session-runtime.ts#L226), [`new_session`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L435) and [`get_messages`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L672) in RPC mode.

## How Codex does it differently

| | pi session file | Codex rollout file |
|---|---|---|
| Path | `sessions/--<cwd>--/<UTC time>_<id>.jsonl` | `sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl` |
| Lines | a header, then entries with `id` and `parentId` | `{timestamp, type, payload}`, no ids or links |
| Shape | a tree; branches live in one file | a flat log; a fork is a new file |
| What is stored | the messages and the settings changes, nothing for UIs only | `response_item` for the model, plus `event_msg` and `turn_context` for UIs and resume |
| Messages | pi's own message shape (provider-neutral) | the Responses API's items, as sent to the model |
| System prompt | a `system` message in the file | `base_instructions` in `session_meta` |
| Compaction | a `compaction` entry: summary + `firstKeptEntryId`; the kept messages are not copied | a `compacted` line with the whole `replacement_history` |
| When the file appears | at the first user or assistant message | also deferred: a new rollout stays in memory until the recorder's [`persist()`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/rollout/src/recorder.rs#L1062) |
| Context rebuild | walk the path, cut at the latest compaction | replay `response_item`s; start again at the latest `compacted` |

Two differences stand out. First, the **tree**: Codex rollouts are a flat log, so a fork or rollback writes a new file or drops turns. pi branches inside one file by moving the leaf. Second, **compaction**: Codex stores the new, shorter history in full (`replacement_history`), so a replay does not need the old lines. pi stores only the summary and a pointer to the first kept entry, and keeps the old entries in the file: the context rule above cuts them out. Both store the summary, so neither has to call the model again to rebuild the context.

The Codex side: [`RolloutRecorder`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/rollout/src/recorder.rs#L86), [`RolloutItem`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/history/src/lib.rs#L212), [`CompactedItem`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/history/src/lib.rs#L287) and the [replay](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/rollout_reconstruction.rs#L64). educodex's version is [`rollout.py`](../../../backends/educodex/src/educodex/core/rollout.py).

## Where edupi is simpler

- **One linear branch.** No `/tree`, fork, clone, labels or branch summaries. The reader still follows `parentId` from the last entry, so a branched pi file opens on its newest branch.
- **Fewer entry types.** No `custom`, `custom_message`, `label`, `session_info` or `usage` entries. A pi file that has them opens, but those entries add nothing to the context. edupi writes `context_edit` entries only to omit a failed overflow attempt (chapter 07).
- **Version 3 only.** pi migrates older files (v1 without ids, v2) and rewrites them. edupi refuses them.
- **`--session` takes a path only.** pi also takes a partial session id and searches the folders, and has `--resume` (a picker), `--fork`, `--session-id` and `--session-dir` (with `PI_CODING_AGENT_SESSION_DIR`).
- **Models from OpenRouter only.** An opened session's model is restored only if its provider is `openrouter`; otherwise edupi uses its default model.
- **Simpler ids and reads.** `uuidv7` leaves out pi's counter for ids made in the same millisecond. Files are read whole, without pi's streaming reader and header scan limits.

## Try it

Chat with edupi, then read its session file:

```bash
export EDUPI_CODING_AGENT_DIR=/tmp/edupi-home/agent
node bin/edupi.mjs --mode rpc --faux examples/faux/demo.json
{"id":"1","type":"get_state"}
{"id":"2","type":"prompt","message":"Say hello."}
{"id":"3","type":"get_messages"}
```

Close stdin (Ctrl-D), then look at the file `get_state` named:

```bash
f=$(find /tmp/edupi-home/agent/sessions -name '*.jsonl' | sort | tail -1)
jq -c '{type, id, parentId, role: .message.role}' "$f"
```

Follow the `parentId` links by hand. Then continue the session and see the old conversation in `get_messages`:

```bash
node bin/edupi.mjs --mode rpc --faux examples/faux/demo.json --continue
{"id":"1","type":"get_messages"}
```

Open the session files the real pi wrote, and compare the two `get_messages` results. The second file has two compactions; find its `firstKeptEntryId`s and work out which messages the context keeps before you look:

```bash
cp test/fixtures/pi/session-compact.jsonl /tmp/pi-compact.jsonl
node bin/edupi.mjs --mode rpc --faux examples/faux/demo.json --session /tmp/pi-compact.jsonl
{"id":"1","type":"get_messages"}
```

In the web UI, open **edupi**, chat, click **new thread** and chat again: the **Protocol** tab shows `new_session`, and the session folder now has two files.

Run the tests:

```bash
npx vitest run test/rpc-session.test.ts
```

## Further reading

- pi's [`docs/session-format.md`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/docs/session-format.md) and [`docs/sessions.md`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/docs/sessions.md).
- [educodex chapter 16](../educodex/16-session-logs.md): Codex's rollout files in detail.
- [RFC 9562, section 5.7](https://www.rfc-editor.org/rfc/rfc9562#section-5.7): UUIDv7.
- [JSON Lines](https://jsonlines.org/): the file format.
