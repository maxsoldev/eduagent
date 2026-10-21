# 13 — Hooks

## Concept

### Rules the model cannot skip

You can write "never run `git push`" in `AGENTS.md`. The model will *usually* obey. Usually is not enough for some rules: a CI check, a secret scanner, a company policy.

A **hook** is your own program that the harness runs at a fixed point in the loop. The model does not choose to call it and cannot talk its way around it. The harness simply runs it every time that point is reached.

```
user prompt ──► [UserPromptSubmit] ──► model ──► tool call ──► [PreToolUse] ──► tool runs ──► [PostToolUse]
                                         ▲                                                       │
                                         └───────────────────────────────────────────────────────┘
                                       model answers without tools ──► [Stop] ──► turn ends
```

| Event | When it runs | What blocking does |
|---|---|---|
| `UserPromptSubmit` | Before the user's message reaches the model | The prompt is rejected and the turn ends |
| `PreToolUse` | Before a tool call runs | The tool does not run; the model gets an error message instead |
| `PostToolUse` | After a tool call ran | The model gets your message instead of the real output |
| `Stop` | When the model wants to finish the turn | The turn continues: your message becomes a new user message |

Hooks sit next to approvals ([chapter 09](09-approvals.md)). An approval asks a *person*. A hook asks a *program*, so it works when nobody is watching.

### The contract: JSON in, exit code out

A hook is any shell command. The harness:
1. starts it,
2. writes one JSON object describing the event to its **stdin**,
3. waits for it to exit.

For example, a `PreToolUse` hook for `exec_command` receives this in educodex:

```json
{
  "hook_event_name": "PreToolUse",
  "session_id": "6f1c2a9e-…",
  "turn_id": "b0d4…",
  "cwd": "/Users/me/project",
  "tool_name": "Bash",
  "tool_input": {"command": "git push origin main"}
}
```

The shell tool is called `Bash` here, not `exec_command`. Codex uses this name so hook scripts written for Claude Code also work with Codex.

The exit code is the answer:

| Exit code | Meaning |
|---|---|
| `0` | Fine, carry on |
| `2` **and** a reason on stderr | Block. The reason is shown to the model (or the user) |
| `2` with empty stderr, or any other code | The hook failed. It is logged and the agent carries on |

That last row matters. A broken hook does not block, so the agent keeps working ("fail open"). To block you must exit with 2 *and* say why.

### `Stop` hooks and `stop_hook_active`

A `Stop` hook can say "you are not done yet":

```bash
echo "Also run the tests before you finish." >&2; exit 2
```

The harness adds that text as a user message and calls the model again. When the model tries to stop a second time, the hook runs again. If it always says "not done", the turn never ends.

To prevent this, the `Stop` payload has a flag:

```json
{"hook_event_name": "Stop", "stop_hook_active": true, "...": "..."}
```

`stop_hook_active` is `false` the first time and `true` once a Stop hook has already sent the model back to work in this turn. A well-behaved hook checks it and lets the turn end.

## In educodex

Everything lives in [`hooks.py`](../../../backends/educodex/src/educodex/core/hooks.py), under 100 lines. Hooks are configured as a dict from event name to a list of shell commands:

```python
Config(hooks={
    "PreToolUse": ["python3 no_push.py"],
    "Stop": ["python3 keep_going.py"],
})
```

There is no config file and no CLI flag for hooks yet. You pass them in `Config` (see [Try it](#try-it)).

**Running a hook** ([`_run`](../../../backends/educodex/src/educodex/core/hooks.py#L30)): start the command with `asyncio.create_subprocess_shell`, write the JSON to stdin, wait up to 600 seconds (Codex's default). A hook that takes longer is killed and counts as failed, so it cannot block anything. Every run emits a `trace/hook` event with the exit code, stdout and stderr.

**Blocking** ([`_blocking_reason`](../../../backends/educodex/src/educodex/core/hooks.py#L51)):

```python
for code, _, err in results:
    if code == BLOCK_EXIT_CODE and err.strip():
        return err.strip()
```

**What the model sees when `PreToolUse` blocks** ([`run_pre_tool_use`](../../../backends/educodex/src/educodex/core/hooks.py#L74)). The text is copied from Codex word for word:

```python
if name in ("Bash", "apply_patch"):
    return f"Command blocked by PreToolUse hook: {reason}. Command: {tool_input['command']}"
return f"Tool call blocked by PreToolUse hook: {reason}. Tool: {name}"
```

This string becomes the tool's output (`function_call_output`), so the model reads it like any other result and can change its plan.

**What `PostToolUse` can do** ([`run_post_tool_use`](../../../backends/educodex/src/educodex/core/hooks.py#L85)). The hook gets the output as `tool_response`. If it exits 2 with a reason, that reason *replaces* the output the model sees. Use it to hide secrets that a command printed, or to add a warning.

**Where they are called** in [`turn.py`](../../../backends/educodex/src/educodex/core/turn.py):
- `UserPromptSubmit` at the start of [`run_turn`](../../../backends/educodex/src/educodex/core/turn.py#L124). A block raises `HookBlocked`; the turn ends with a `warning` notification.
- `PreToolUse` and `PostToolUse` around each tool call in [`run_tool_calls`](../../../backends/educodex/src/educodex/core/turn.py#L247). If `PreToolUse` blocks, the tool does not run and `PostToolUse` is skipped. As in Codex, `write_stdin` gets no tool hooks: it only feeds a command that `PreToolUse` already saw.
- `Stop` when the model gives an answer without tool calls ([L157](../../../backends/educodex/src/educodex/core/turn.py#L157)):

```python
if continuation := await hooks.run_stop(ctx, stop_hook_active):
    stop_hook_active = True
    await session.record(user_message(continuation))
    continue
break
```

## In Codex

Codex's hook engine is the [`hooks/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/hooks) crate. The core calls it from [`core/src/hook_runtime.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/hook_runtime.rs).

| What | Where in Codex |
|---|---|
| Events and config shape (`PreToolUse`, `Stop`, …, 12 events) | [`config/src/hook_config.rs#L36`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/config/src/hook_config.rs#L36) |
| Handler types: `command`, `mcp_tool` (`prompt`, `agent` are parsed but skipped as "not supported yet") | [`hook_config.rs#L163`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/config/src/hook_config.rs#L163), [`engine/discovery.rs#L637`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/hooks/src/engine/discovery.rs#L637) |
| Loading `hooks.json` and `[hooks]` in `config.toml` | [`discovery.rs#L339`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/hooks/src/engine/discovery.rs#L339), [`#L382`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/hooks/src/engine/discovery.rs#L382) |
| Default timeout: 600 s | [`discovery.rs#L764`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/hooks/src/engine/discovery.rs#L764) |
| Stdin JSON for `PreToolUse` | [`hooks/src/schema.rs#L278`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/hooks/src/schema.rs#L278), [`events/pre_tool_use.rs` `command_input_json`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/hooks/src/events/pre_tool_use.rs#L175) |
| Exit 2 + stderr = block | [`pre_tool_use.rs#L261`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/hooks/src/events/pre_tool_use.rs#L261), [`user_prompt_submit.rs#L227`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/hooks/src/events/user_prompt_submit.rs#L227), [`post_tool_use.rs#L259`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/hooks/src/events/post_tool_use.rs#L259), [`stop.rs#L343`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/hooks/src/events/stop.rs#L343) |
| The "blocked by PreToolUse hook" messages | [`hook_runtime.rs#L233`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/hook_runtime.rs#L233) |
| Shell tools appear as `Bash`; `apply_patch` also matches `Write`/`Edit` | [`core/src/tools/hook_names.rs#L54`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/hook_names.rs#L54), [`exec_command.rs#L514`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs#L514) |
| Pre/Post hooks around every tool call | [`core/src/tools/registry.rs#L628`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/registry.rs#L628), [`#L789`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/registry.rs#L789) |
| `Stop` and `stop_hook_active` in the loop | [`core/src/session/turn.rs#L658`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/turn.rs#L658) |
| Running the command (stdin, timeout) | [`engine/command_runner.rs#L276`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/hooks/src/engine/command_runner.rs#L276) |

A Codex `hooks.json` looks like this. Note the extra *matcher* level, a regex on the tool name:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "python3 ~/.codex/hooks/no_push.py", "timeout": 10 }] }
    ]
  }
}
```

Some details worth knowing:
- **Exit 0 can also carry JSON.** A hook may print JSON on stdout instead of using exit 2, e.g. `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "…"}}`. A `PreToolUse` hook can even rewrite the tool input (`updatedInput`).
- **Extra stdin fields:** `model`, `permission_mode` (`"bypassPermissions"` under `never`, else `"default"`, [L1032](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/hook_runtime.rs#L1032)), `transcript_path` and `tool_use_id`. `Stop` also gets `last_assistant_message`.
- **The Stop continuation is tagged.** It is a user message wrapped as `<hook_prompt hook_run_id="…">…</hook_prompt>` ([`protocol/src/items.rs#L115`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/items.rs#L115)), so UIs can show it as coming from a hook.
- **Matching hooks run at the same time**, not one after another.
- **Trust.** Hooks are code that runs on your machine without a sandbox. Codex only runs a non-managed hook after you have reviewed and trusted its exact definition (`/hooks` in the CLI).

## Where educodex is simpler

| Codex | educodex |
|---|---|
| 12 events (also `SessionStart`, `PreCompact`, `PermissionRequest`, `SubagentStop`, …) | 4 events |
| `hooks.json` / `config.toml`, matchers, trust review | A Python dict in `Config`, no matchers, no trust check |
| `command` and `mcp_tool` handlers, JSON output, `updatedInput` | Shell commands, exit code + stderr only |
| `PostToolUse` only after a successful call | After every call that ran, also failed ones (still none after a blocked call or for `write_stdin`) |
| Hooks run concurrently; timeout 600 s by default, configurable per hook | One after another; fixed 600 s timeout |
| Stop continuation as `<hook_prompt>` message | Plain user message |

## Try it

Make an empty folder with three files.

`no_push.py`, a `PreToolUse` hook:

```python
import json, sys

event = json.load(sys.stdin)                     # what is about to happen
command = event["tool_input"].get("command", "")
if event["tool_name"] == "Bash" and "git push" in command:
    print("pushing is done by humans", file=sys.stderr)
    sys.exit(2)                                  # 2 = block
```

`keep_going.py`, a `Stop` hook:

```python
import json, sys

event = json.load(sys.stdin)
if not event["stop_hook_active"]:                # first time we stop in this turn
    print("Also run the tests before you finish.", file=sys.stderr)
    sys.exit(2)                                  # 2 = do not stop yet
```

`hooks_demo.py` drives a session with the fake model, so no API key is needed:

```python
import asyncio, json
from educodex.core.config import Config
from educodex.core.session import Session
from educodex.testing.fake_model import FakeModel

fake = FakeModel([
    [{"type": "function_call", "name": "exec_command", "arguments": json.dumps({"cmd": "git push"})}],
    [{"type": "message", "text": "Pushing was blocked, so I stopped."}],
    [{"type": "message", "text": "OK, the tests pass."}],
])
config = Config(cwd=".", api_key="fake", hooks={
    "PreToolUse": ["python3 no_push.py"],
    "Stop": ["python3 keep_going.py"],
})

async def main():
    session = Session(config, transport=fake)
    await session.start()
    await session.run("push my branch")
    await session.close()
    for i, request in enumerate(fake.requests):   # the last input item of each model request
        print(i, json.dumps(request["input"][-1]))

asyncio.run(main())
```

Run it from that folder:

```bash
uv run --project /path/to/educodex python hooks_demo.py
```

Output (shortened):

```
0 {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "push my branch"}]}
1 {"type": "function_call_output", "call_id": "call_…", "output": "Command blocked by PreToolUse hook: pushing is done by humans. Command: git push"}
2 {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Also run the tests before you finish."}]}
```

Request 1 shows that `git push` never ran: the model got the block message as the tool output. Request 2 shows the Stop hook sending the model back to work. The third time, `stop_hook_active` is `true`, so the hook exits 0 and the turn ends.

To see the `trace/hook` events too, subscribe to `session.bus` and print every event whose method is `trace/hook`.

## Further reading
- [Codex hooks](https://developers.openai.com/codex/hooks): events, config locations, trust review, JSON output.
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks): the design Codex's hooks are compatible with (`Bash` tool name, exit code 2, `stop_hook_active`).
- [Designing agentic loops](https://simonw.substack.com/p/designing-agentic-loops): where deterministic checks fit around a model.
