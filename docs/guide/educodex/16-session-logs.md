# 16 — Session logs

## Concept

### History lives in memory, so write it down

The conversation history (chapter 04) is a Python list. If the app crashes or you close it, the list is gone. A harness also needs the history later, to:
- **resume** a session tomorrow,
- **debug**: "what exactly did the model see before it ran `rm`?",
- **audit** what an agent did on someone's machine,
- **evaluate**: replay many sessions to compare prompts or models.

Codex writes every session to a **rollout file**: one JSON object per line (JSONL), appended as things happen. Appending one line at a time is cheap, and a crash loses at most the last line.

### Where the files go

```
~/.codex/sessions/2026/10/08/rollout-2026-10-08T10-13-42-9298532d-1597-4bde-a82b-311e9bd61aba.jsonl
                  └─ YYYY/MM/DD ┘        └─ local start time ┘ └──────── thread id ────────────┘
```

educodex uses the same layout under `~/.eduagent/.educodex/sessions/` (or `$EDUCODEX_HOME/sessions/`).

### What a line looks like

Every line has the same envelope:

```json
{"timestamp": "2026-10-08T08:14:26.516+00:00", "type": "response_item", "payload": { ... }}
```

`type` says what the payload is:

| `type` | Payload | Written when |
|---|---|---|
| `session_meta` | Thread id, cwd, originator, CLI version, model provider, **base instructions** | Once, at the start |
| `turn_context` | Settings for this turn: cwd, approval policy, sandbox, model, date | Each turn |
| `response_item` | One item **exactly as the model sees it**: message, reasoning, function_call, ..._output | Each time history grows |
| `event_msg` | Something that happened, for UIs: `task_started`, `user_message`, `agent_message`, `token_count`, `task_complete`, `turn_aborted` | As it happens |
| `compacted` | The summary plus `replacement_history`: the new, shorter history | After compaction (chapter 15) |

A real educodex session, shortened:

```json
{"type": "session_meta",  "payload": {"id": "9298532d-…", "cwd": "/private/tmp/edx-real", "originator": "educodex", "model_provider": "openrouter", "base_instructions": {"text": "You are Codex, an agent based on GPT-6. …"}}}
{"type": "event_msg",     "payload": {"type": "task_started", "turn_id": "941b259a-…"}}
{"type": "response_item", "payload": {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "<permissions instructions>…"}]}}
{"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "<environment_context>…"}]}}
{"type": "turn_context",  "payload": {"turn_id": "941b259a-…", "approval_policy": "on-request", "sandbox_policy": {"type": "workspace-write"}, "model": "openai/gpt-6-luna"}}
{"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Create a tiny Python package `greet` …"}]}}
{"type": "response_item", "payload": {"type": "reasoning", "summary": [], "encrypted_content": "gAAAAABqx1Di…"}}
{"type": "response_item", "payload": {"type": "function_call", "name": "exec_command", "arguments": "{\"cmd\":\"rg --files …\"}", "call_id": "call_YXVU…"}}
{"type": "event_msg",     "payload": {"type": "token_count", "info": {"input_tokens": 5551, "output_tokens": 123, "total_tokens": 5674, …}}}
{"type": "response_item", "payload": {"type": "function_call_output", "call_id": "call_YXVU…", "output": "Chunk ID: 7604ea\nWall time: 0.0913 seconds\n…"}}
```

### Two kinds of lines: for the model and for people

The key idea: **`response_item` lines are the model's history**. Read them in order and you have the exact `input` list (minus `input[0]`, the base instructions, which are in `session_meta`). Everything else (`event_msg`, `turn_context`) is for UIs, resume logic and debugging.

Replaying is a short loop:

```
history = []
for line in file:
    response_item → history.append(payload)
    compacted     → history = payload.replacement_history     # compaction replaced everything before
    anything else → skip
```

Compaction is why the `compacted` line stores the whole replacement history. Without it, a replay would have to rerun the summarisation request to get back the same history.

## In educodex

[`rollout.py`](../../../backends/educodex/src/educodex/core/rollout.py) has a `RolloutRecorder` with one method per line type, and a reader:

```python
def _write(self, kind: str, payload: dict[str, Any]) -> None:
    if self._file is None:                       # the file is created on the first write
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._file = self.path.open("a")
    line = {"timestamp": datetime.datetime.now(datetime.UTC).isoformat(timespec="milliseconds"),
            "type": kind, "payload": payload}
    self._file.write(json.dumps(line, ensure_ascii=False) + "\n")
    self._file.flush()
```

```python
def history_from_rollout(lines):
    """Rebuild model-visible history: response items, with compactions replacing what came before."""
    history = []
    for line in lines:
        if line["type"] == "response_item":
            history.append(line["payload"])
        elif line["type"] == "compacted" and line["payload"].get("replacement_history") is not None:
            history = list(line["payload"]["replacement_history"])
    return history
```

Who writes what:
- [`session.py`](../../../backends/educodex/src/educodex/core/session.py): `session_meta` in `start()`. Every `Session.record()` call appends to history **and** writes a `response_item`. History and log can't drift apart, because they are written in one place.
- [`turn.py`](../../../backends/educodex/src/educodex/core/turn.py): `turn_context` and the `event_msg` lines (`task_started`, `user_message`, `agent_message`, `token_count`, `turn_aborted`, `task_complete`).
- [`compact.py`](../../../backends/educodex/src/educodex/core/compact.py): the `compacted` line, after the history is swapped.

`tests/test_turn.py::test_rollout_replays_history` checks the main promise: `history_from_rollout(lines) == session.history.items`.

The app server's `thread/start` result includes the rollout `path`, so a UI can show where the log is.

An **ephemeral** thread (`Config(ephemeral=True)`) writes no log, and its `path` is `null`, as in Codex. The memory agent (chapter 17) runs this way. Session logs are also the input of memories: phase 1 reads them, so a thread that should never become a memory must not leave a log.

## In Codex

| What | Where |
|---|---|
| `RolloutRecorder` (with a `jq` hint in the doc comment) | [`rollout/src/recorder.rs#L86`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/rollout/src/recorder.rs#L86) |
| Path: `sessions/YYYY/MM/DD`, local time | [`recorder.rs#L1739`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/rollout/src/recorder.rs#L1739) |
| Writing one line, UTC timestamp | [`recorder.rs#L2088`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/rollout/src/recorder.rs#L2088) |
| File name `rollout-<time>-<thread id>.jsonl` | [`rollout/src/rollout_file_name.rs#L62`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/rollout/src/rollout_file_name.rs#L62) |
| `RolloutItem`: all line types | [`history/src/lib.rs#L212`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/history/src/lib.rs#L212) |
| `RolloutLine`: `timestamp`, `ordinal`, flattened item | [`history/src/lib.rs#L362`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/history/src/lib.rs#L362) |
| `CompactedItem` with `replacement_history` | [`history/src/lib.rs#L287`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/history/src/lib.rs#L287) |
| Wire shape `{"type": ..., "payload": ...}` | [`history/src/rollout_payload.rs#L33`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/history/src/rollout_payload.rs#L33) |
| `SessionMeta`, `TurnContextItem` | [`protocol/src/protocol.rs#L3181`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/protocol.rs#L3181), [`#L3353`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/protocol.rs#L3353) |
| `task_started` / `task_complete` names | [`protocol.rs#L1450`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/protocol.rs#L1450) |
| Which items and events are persisted | [`rollout/src/policy.rs#L80`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/rollout/src/policy.rs#L80) and [`#L127`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/rollout/src/policy.rs#L127) |
| Replay: pick the newest compaction, replay the rest | [`core/src/session/rollout_reconstruction.rs#L64`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/rollout_reconstruction.rs#L64) and [`#L508`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/rollout_reconstruction.rs#L508) |
| App-server `thread/resume`, `thread/fork` | [`app-server-protocol/src/protocol/common.rs#L558`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/protocol/common.rs#L558) |

Codex replays from the end: it finds the newest `compacted` line, starts from its `replacement_history`, and replays only the lines after it. That is faster for long sessions and gives the same result as educodex's forward loop.

### Comparing with a real Codex rollout

A recent Codex rollout (CLI 0.159) on this machine has more line types than educodex writes:

| Line | Meaning |
|---|---|
| `"ordinal": 5` on every line | A sequence number, so lines can be referenced and paged |
| `world_state` | A snapshot of the context fragments (AGENTS.md, environment, permissions, ...) used to work out what changed (chapter 05) |
| `token_usage_record` | Per-response usage for the turn and the thread |
| `event_msg` `item_completed`, `thread_settings_applied` | Newer "paginated" sessions store finished UI items instead of the older `user_message` / `agent_message` events |
| `response_item` with `metadata` and `internal_chat_message_metadata_passthrough` | Extra bookkeeping next to the item |

`session_meta` also carries the git commit, branch and repo URL, and where the base instructions came from. The core is the same: `response_item` lines rebuild the model's history, and educodex's `history_from_rollout` can read a Codex file directly (see Try it).

## Where educodex is simpler

- **No resume.** educodex writes rollouts but never loads one back into a session. `thread/list` lists only threads in memory. Codex has `thread/resume`, `thread/fork` and rollback (dropping the last N turns).
- **Forward replay only.** No reverse scan, no `ordinal`, no pagination, no "legacy compaction without `replacement_history`" handling.
- **Fewer line types.** No `world_state`, `token_usage_record`, `retained_context`, inter-agent or realtime lines.
- **Legacy-style events.** educodex writes `user_message` / `agent_message` events (Codex's `Legacy` history mode) instead of `item_completed`.
- **No index or database.** Codex keeps a session index and a SQLite state DB to list and search sessions quickly, plus a writer lock so two processes can't append to one file, and compression of old files.
- **Smaller `session_meta` and `turn_context`.** No git info, no permission profile, no collaboration mode, no reasoning settings.

## Try it

Run something, then read its log (needs `OPENROUTER_API_KEY`):

```bash
uv run educodex exec "List the files here and count them"
f=$(find ~/.eduagent/.educodex/sessions -name 'rollout-*.jsonl' | sort | tail -1)
jq -r '.type + " " + (.payload.type // "")' "$f"
```

`exec` also prints the file's path as its last line (`session log: …`). Offline, add `--fake-model examples/fake/demo.json` (and `--cwd` to a scratch folder) to get a log without an API key.

You see the order of events: `session_meta`, `task_started`, context messages, `turn_context`, the user message, then reasoning / tool calls / outputs, `token_count`, and finally `task_complete`.

Rebuild the model's history from the file:

```bash
uv run python -c "
import sys
from pathlib import Path
from educodex.core.rollout import read_rollout, history_from_rollout
for item in history_from_rollout(read_rollout(Path(sys.argv[1]))):
    print(item['type'], item.get('role', item.get('name', '')))" "$f"
```

The same works on a real Codex rollout, if you have used Codex:

```bash
f=$(find ~/.codex/sessions -name 'rollout-*.jsonl' | sort | tail -1)
jq -r '.type + " " + (.payload.type // "")' "$f" | sort | uniq -c
```

Then run the Python snippet above on it. Compare the counts with an educodex file and look for the extra line types from the table.

The web UI writes logs too: [start the launcher](README.md#the-web-ui), pick **educodex** (or **educodex-demo** offline), send a message, then open the newest file. The **Context** tab shows the same items the `response_item` lines contain. The `path` in the `thread/started` notification (**Protocol** tab) tells you which file it is.

Run the replay test:

```bash
uv run --group dev pytest tests/test_turn.py -k rollout -v
```

## Further reading
- [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/): why the full history is resent, which is what makes replay possible.
- [Unlocking the Codex harness: how we built the App Server](https://openai.com/index/unlocking-the-codex-harness/): threads that persist and can be resumed by any client.
- [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents): keeping progress across sessions.
- [JSON Lines](https://jsonlines.org/): the file format.
