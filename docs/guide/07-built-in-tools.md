# 07 — Built-in tools

## Concept

### Three tools are enough for a coding agent

Codex gives the model a short list of built-in tools. educodex keeps the core ones:

| Tool | Kind | What it does |
|---|---|---|
| `exec_command` | function (JSON args) | Run a shell command. Returns its output, or a session ID if it is still running |
| `write_stdin` | function | Type into a running command, or just wait for more output |
| `apply_patch` | custom (freeform text + grammar) | Add, update, delete or move files using a patch |
| `update_plan` | function | Show a checklist of steps to the user |

With a shell the model can read files (`cat`, `rg`), run tests and use git. With `apply_patch` it can edit files. Everything else is optional.

### Tool descriptions are prompts

The model never sees your Python code. It only sees the tool's **name, description and parameter schema**, and decides from that text alone how to call the tool. So every word in a spec acts as a prompt:

```json
{
  "type": "function",
  "name": "exec_command",
  "description": "Runs a command in a PTY, returning output or a session ID for ongoing interaction.",
  "parameters": {
    "type": "object",
    "properties": {
      "cmd": {"type": "string", "description": "Shell command to execute."},
      "yield_time_ms": {"type": "number",
        "description": "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms."},
      "max_output_tokens": {"type": "number",
        "description": "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy."}
    },
    "required": ["cmd"]
  }
}
```

The spec is trimmed here; the real one also has `workdir`, `tty`, `shell`, `login`, `sandbox_permissions`, `justification` and `prefix_rule`. Codex's descriptions are short because the models were trained on these exact tools. The GPT-6 base prompt does not even mention `apply_patch`; the grammar and training are enough.

### `exec_command`: commands that may not finish

Some commands finish in milliseconds (`ls`). Others run for minutes (`npm test`) or forever (`npm run dev`). A harness must not block on them. Codex's answer is a **session**:

```
model: exec_command {"cmd": "npm run dev"}
harness: start it, wait up to yield_time_ms (default 10 s)
         still running → return output so far + "Process running with session ID 1001"
model: write_stdin {"session_id": 1001, "chars": ""}        ← empty = just wait and poll
harness: wait (polls: 5 s by default, up to 300 s), return only the NEW output
model: write_stdin {"session_id": 1001, "chars": "q\n"}     ← type into the process
harness: process exited → "Process exited with code 0"
```

The rules come from Codex:
- `yield_time_ms` is clamped to 250–30,000 ms.
- An empty `write_stdin` (a poll) waits 5,000–300,000 ms (default 5,000), so the model does not spin and can wait a long time for a slow build.
- At most 64 processes stay alive. Each keeps at most 1 MiB of output.
- After a process exits, the harness waits at most 50 ms more for output. A background child (`server &`) may keep the pipe open forever.

By default, commands use plain **pipes**, not a PTY (pseudo-terminal). The description says "PTY", but `tty` defaults to `false`.

The `shell` parameter picks a shell *type*, not a program. `"zsh"` or `"/usr/local/bin/zsh"` both mean `/bin/zsh`; anything that is not bash, zsh or sh becomes `/bin/sh`. Otherwise a model could ask to "launch" `/tmp/evil.sh` as its shell.

`exec_command` and `write_stdin` are parallel-safe: if the model asks for several commands in one reply, they run side by side (chapter 04).

### Output format

Every `exec_command` / `write_stdin` result looks like this:

```
Chunk ID: 4dbff6
Wall time: 0.0123 seconds
Process exited with code 0
Original token count: 2
Output:
hello
```

- `Chunk ID`: 6 random hex digits.
- `Process exited with code N` is replaced by `Process running with session ID N` while the command is still running.
- `Original token count` is the size before truncation (about 4 bytes per token).

### Middle truncation

Tool output can be huge (`cat` a log file, `seq 1 100000`). The model's catalog entry caps it: `truncation_policy.limit`, 10,000 tokens for current models (chapter 06). The model can ask for less with `max_output_tokens`, never more.

What gets cut? Errors usually appear at the **end** (the failing test, the stack trace). The command and the first lines tell you **what** ran. So the harness keeps the start and the end and drops the middle:

```
1
2
...
70…27124 tokens truncated…67
19968
...
20000
```

That is `seq 1 20000` cut to 100 tokens: 200 bytes of head, 200 bytes of tail, and a marker saying how much went missing. The model can then rerun with `| tail` or `rg` if it needs the middle.

### `apply_patch`: a format made for models

Rewriting a whole file to change one line wastes tokens and invites mistakes. Line-number diffs break because models are bad at counting lines. Codex uses its own patch format, which finds the place to edit by **content**:

```
*** Begin Patch
*** Add File: hello.txt
+hi
*** Update File: src/app.py
@@ def main():
-    print("old")
+    print("new")
*** Delete File: obsolete.txt
*** End Patch
```

- `@@ def main():` is optional context: "jump to the line `def main():` first".
- Lines with ` ` (space) or `-` must already exist in the file; `+` lines are added.
- `*** Move to: new/path.py` after `*** Update File:` renames the file.

The tool is **freeform** (`"type": "custom"`): the model writes raw text, and the API forces that text to match a Lark grammar (chapter 03). That removes a whole class of errors, such as patches escaped inside JSON strings.

Models still get whitespace or punctuation slightly wrong. So the matcher, `seek_sequence`, tries four times, each looser than the last:
1. exact match,
2. ignoring trailing whitespace,
3. ignoring leading and trailing whitespace,
4. also treating Unicode dashes, quotes and odd spaces as their ASCII forms (`—` → `-`, `“` → `"`).

On success the model gets a short summary, in the older "Exit code / Wall time" format:

```
Exit code: 0
Wall time: 0.0 seconds
Output:
Success. Updated the following files:
A hello.txt
M src/app.py
D obsolete.txt
```

The wall time here has one decimal, as in Codex. If the patch does not parse or does not match the file, the output is just the error text, for example `apply_patch verification failed: Failed to find expected lines in src/app.py: ...`. The model reads it and usually retries with more context.

### `update_plan`: a tool with no side effects

`update_plan` takes a list of `{step, status}` items (`pending`, `in_progress`, `completed`) and returns just `"Plan updated"`. Its value is for the user (a live checklist in the UI) and for the model. Writing the plan down keeps the model on track during long tasks (see the "todo recitation" idea in the Manus post below). In Codex it is off unless you enable `[tools.update_plan]`; educodex turns it on for the demo.

## In educodex

| File | What |
|---|---|
| [`tools/specs.py`](../../src/educodex/core/tools/specs.py) | The JSON specs, copied field by field from Codex |
| [`tools/handlers.py`](../../src/educodex/core/tools/handlers.py) | One handler class per tool: check policy, maybe ask, run, format |
| [`tools/processes.py`](../../src/educodex/core/tools/processes.py) | `ProcessManager`: sessions, yield times, 1 MiB buffers |
| [`tools/output.py`](../../src/educodex/core/tools/output.py) | `format_exec_output`, `truncate_middle` |
| [`tools/apply_patch.py`](../../src/educodex/core/tools/apply_patch.py) | Parse the patch, `seek_sequence`, apply, summary |
| [`tools/registry.py`](../../src/educodex/core/tools/registry.py) | `ToolRouter`: stable spec order, dispatch by name |

The heart of sessions is `_collect`: wait for exit *or* the yield time, then return only output the model has not seen yet:

```python
async def _collect(self, process, yield_ms, started):
    try:
        await asyncio.wait_for(asyncio.shield(process.proc.wait()), yield_ms / 1000)
    except TimeoutError:
        pass                                   # still running: fine, report a session id
    exited = process.proc.returncode is not None
    ...
    output = process.buffer[process.read_offset :].decode(errors="replace")
    process.read_offset = len(process.buffer)  # next poll starts here
```

`asyncio.shield` matters: the timeout cancels the *wait*, not the process.

Middle truncation is a dozen lines:

```python
def truncate_middle(text: str, max_tokens: int) -> tuple[str, int | None]:
    data = text.encode()
    max_bytes = max_tokens * BYTES_PER_TOKEN
    if len(data) <= max_bytes:
        return text, None
    left = max_bytes // 2
    right = max_bytes - left
    head = data[:left].decode(errors="ignore")
    tail = data[len(data) - right :].decode(errors="ignore")
    removed = (len(data) - max_bytes + BYTES_PER_TOKEN - 1) // BYTES_PER_TOKEN
    return f"{head}…{removed} tokens truncated…{tail}", approx_token_count(text)
```

`apply_patch` works in two steps. `plan_changes` computes every new file in memory, without touching disk, so the policy can check the paths first (chapter 09). Then `apply_planned` writes the files.

`builtin_handlers` registers the tools in Codex's order. `apply_patch` is only added when the model's catalog entry has an `apply_patch_tool_type` (chapter 06).

Tool errors are not crashes. A handler raises `ToolError`, and the router turns it into the tool's output text, so the model reads the error and tries again.

## In Codex

| What | Where |
|---|---|
| `exec_command` and `write_stdin` specs | [`core/src/tools/handlers/shell_spec.rs#L15`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/handlers/shell_spec.rs#L15), [`shell_spec.rs#L117`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/handlers/shell_spec.rs#L117) |
| `exec_command` args; `tty` defaults to `false` | [`core/src/tools/handlers/unified_exec.rs#L29`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/handlers/unified_exec.rs#L29) |
| Limits: yield times, 1 MiB, 64 processes | [`core/src/unified_exec/mod.rs#L73`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/unified_exec/mod.rs#L73) |
| Poll vs write yield clamping | [`core/src/unified_exec/process_manager.rs#L1013`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/unified_exec/process_manager.rs#L1013) |
| 50 ms wait after exit | [`process_manager.rs#L1578`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/unified_exec/process_manager.rs#L1578) |
| Head + tail output buffer | [`core/src/unified_exec/head_tail_buffer.rs#L11`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/unified_exec/head_tail_buffer.rs#L11) |
| Output header (`Chunk ID`, `Wall time`, ...) | [`core/src/tools/context.rs#L524`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/context.rs#L524) |
| Middle truncation by token budget | [`utils/string/src/truncate.rs#L39`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/utils/string/src/truncate.rs#L39) and the marker at [`#L161`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/utils/string/src/truncate.rs#L161) |
| "Warning: truncated output" wrapper | [`utils/output-truncation/src/lib.rs#L23`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/utils/output-truncation/src/lib.rs#L23) |
| `Exit code:` format (used for `apply_patch`) | [`core/src/tools/mod.rs#L101`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/mod.rs#L101) |
| `apply_patch` spec + grammar | [`core/src/tools/handlers/apply_patch_spec.rs#L9`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/handlers/apply_patch_spec.rs#L9), [`core/assets/tools/apply_patch.lark`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/assets/tools/apply_patch.lark) |
| Patch markers and parser | [`apply-patch/src/parser.rs#L37`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/apply-patch/src/parser.rs#L37) |
| `seek_sequence` (4 levels) | [`apply-patch/src/seek_sequence.rs#L12`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/apply-patch/src/seek_sequence.rs#L12) |
| Locating chunks | [`apply-patch/src/file_update.rs#L60`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/apply-patch/src/file_update.rs#L60) |
| `Success. Updated the following files:` | [`apply-patch/src/lib.rs#L826`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/apply-patch/src/lib.rs#L826) |
| `apply_patch` handler | [`core/src/tools/handlers/apply_patch.rs#L302`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/handlers/apply_patch.rs#L302) |
| `update_plan` spec and handler | [`plan_spec.rs#L7`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/handlers/plan_spec.rs#L7), [`plan.rs#L22`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/handlers/plan.rs#L22) |
| Which tools are registered | [`core/src/tools/spec_plan.rs#L1150`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/spec_plan.rs#L1150) (shell), [`#L1228`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/spec_plan.rs#L1228) (plan), [`#L1344`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/spec_plan.rs#L1344) (patch) |

## Where educodex is simpler

- **Pipes only.** `tty: true` is accepted but ignored; Codex can allocate a real PTY. Programs that need a terminal (`vim`, some prompts) will behave differently.
- **Buffer keeps only the newest 1 MiB.** Codex's `HeadTailBuffer` keeps the first and last 512 KiB and adds a `... N bytes omitted ...` marker.
- **Simpler truncation text.** When output is cut, Codex adds a `Warning: truncated output (original token count: N)` line and a 20% allowance for the header. educodex just inserts the `…N tokens truncated…` marker.
- **Fixed limits.** Codex lets you configure the 300 s poll cap and the process limit. At 64 processes educodex returns an error; Codex closes the oldest process instead.
- **No `Total output lines`.** Codex's `Exit code:` format adds that line when output was truncated. educodex does not.
- **No shell snapshot, no Windows paths, no `environment_id`, no streaming patch preview.** Codex runs commands with a saved snapshot of your shell setup and can stream a diff while the model is still writing the patch.

## Try it

Watch a command, a patch and a plan (needs `OPENROUTER_API_KEY`):

```bash
uv run educodex exec "Make a plan, then create hello.py that prints hi, and run it"
```

Each `tool call` line shows the arguments the model chose; `tool output` shows the formatted text it got back.

See middle truncation:

```bash
uv run educodex exec -v "Run exactly: seq 1 100000"
```

The output is ~590 KB, far over 10,000 tokens. Look for `…N tokens truncated…` and `Original token count` in the tool output.

See a session:

```bash
uv run educodex exec "Run 'sleep 15; echo done' and tell me what it printed"
```

The first result says `Process running with session ID …`; the model then calls `write_stdin` to wait for the rest.

Offline, `uv run educodex exec --cwd /tmp/edu-demo --fake-model examples/fake/demo.json "go"` runs a scripted plan, `ls`, patch and `python3 hello.py` (create `/tmp/edu-demo` first).

In the web UI (`uv run educodex app-server`, then http://127.0.0.1:8765), or offline with `uv run educodex app-server --fake-model examples/fake/demo.json`:
- **Tools** tab: every spec exactly as sent, including the full Lark grammar for `apply_patch`.
- **Timeline** tab: `trace/toolDispatch` (the call) and `trace/toolOutput` (the formatted text and its size).
- **Guardrails** tab: the policy decision made before each command or patch.

Run the tool tests:

```bash
uv run --group dev pytest tests/test_output.py tests/test_apply_patch.py -v
```

`test_fuzzy_match_ignores_whitespace_and_unicode_dashes` shows `seek_sequence` matching a patch written with `-` against a file containing `—`.

## Further reading
- [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents): names, descriptions and output size as part of the prompt.
- [Edit formats](https://aider.chat/docs/more/edit-formats.html): whole-file vs diff vs search/replace edits.
- [Function calling guide](https://platform.openai.com/docs/guides/function-calling): function and custom (freeform) tools.
- [Context Engineering for AI Agents: Lessons from Building Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus): keeping errors in context, todo lists as recitation.
