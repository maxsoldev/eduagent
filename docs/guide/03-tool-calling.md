# 03 — Tool calling

## Concept

### The model asks, the harness acts

A model can only produce text. To let it *do* things, the harness lists **tools** in the request. The model can then answer with a **tool call** instead of a message: "please run `exec_command` with `cmd: "ls"`". The harness runs it and sends the result back in the next request.

```
harness ──► request: tools=[exec_command, apply_patch, ...], input=[..., user: "list files"]
model   ──► function_call  {name: "exec_command", arguments: "{\"cmd\":\"ls\"}", call_id: "call_1"}
harness     runs `ls`
harness ──► request: input=[..., function_call(call_1), function_call_output(call_1, "README.md ...")]
model   ──► message "There is one file: README.md."
```

The model never touches your machine. It only writes requests. Whether and how to run them is up to the harness (chapters 09–11).

### Function tools and JSON Schema

A **function tool** has a name, a description and a **JSON Schema** for its arguments. This is (shortened) the `update_plan` spec educodex and Codex send:

```json
{
  "type": "function",
  "name": "update_plan",
  "description": "Updates the task plan.\nProvide an optional explanation and a list of plan items, ...",
  "strict": false,
  "parameters": {
    "type": "object",
    "properties": {
      "explanation": {"type": "string", "description": "Optional explanation for this plan update."},
      "plan": {"type": "array", "items": {"type": "object",
               "properties": {"step": {"type": "string"},
                              "status": {"type": "string", "enum": ["pending", "in_progress", "completed"]}},
               "required": ["step", "status"]}}
    },
    "required": ["plan"],
    "additionalProperties": false
  }
}
```

The model sees only this JSON. The description is a prompt: it is the model's only guide to when and how to use the tool.

The model answers with a `function_call` item. Note that `arguments` is a **string** containing JSON, not a JSON object. The harness must parse it, and parsing can fail:

```json
{"type": "function_call", "name": "update_plan", "call_id": "call_abc",
 "arguments": "{\"plan\": [{\"step\": \"Create hello.py\", \"status\": \"in_progress\"}]}"}
```

`"strict": false` means the API doesn't force the arguments to match the schema exactly. The harness must check them itself.

### Freeform tools with a grammar

Some inputs are awkward inside JSON. A code patch full of quotes and newlines becomes a mess of `\"` and `\n` escapes, and models make mistakes there. So the Responses API also has **custom (freeform) tools**: the model writes raw text, and an optional **grammar** limits what it may write.

Codex's `apply_patch` is a freeform tool with a [Lark](https://lark-parser.readthedocs.io/en/latest/grammar.html) grammar:

```json
{"type": "custom", "name": "apply_patch",
 "description": "The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
 "format": {"type": "grammar", "syntax": "lark", "definition": "start: begin_patch hunk+ end_patch\n..."}}
```

The start of the grammar:

```
start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?
hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
```

The server uses the grammar while sampling, so the model *cannot* produce a patch with the wrong shape. The call comes back as a `custom_tool_call` with plain text in `input`:

```json
{"type": "custom_tool_call", "name": "apply_patch", "call_id": "call_Tt9K...",
 "input": "*** Begin Patch\n*** Add File: hello.txt\n+hi\n*** End Patch\n"}
```

(Real output from `spikes/out/roundtrip_1.json`.)

### `call_id`: matching answers to questions

Every call has a `call_id`. The harness answers with an **output item of the matching type** and the **same `call_id`**:

| Call | Answer |
|---|---|
| `function_call` | `{"type": "function_call_output", "call_id": "call_abc", "output": "Plan updated"}` |
| `custom_tool_call` | `{"type": "custom_tool_call_output", "call_id": "call_Tt9K...", "output": "Exit code: 0\nWall time: 0.0 seconds\nOutput:\nSuccess. Updated the following files:\nA hello.txt\n"}` |

The model may make several calls in one response. The `call_id`s say which output belongs to which call.

Two rules the API enforces:
- Every call in `input` needs an output. A "dangling" call is rejected.
- Every output needs its call.

So when a call never got an answer (the user interrupted, say), the harness inserts an output saying `"aborted"` before sending.

### Errors are outputs, not crashes

If the arguments don't parse, or the tool doesn't exist, the harness doesn't crash. It sends the error back as the tool's output, like `failed to parse function arguments: ...`. The model reads it and usually fixes its next call.

### Namespace tools (preview)

A tool can also be a **namespace**: a group of functions under one name. educodex uses this for MCP servers (chapter 12):

```json
{"type": "namespace", "name": "mcp__notes", "description": "Tools in the mcp__notes namespace.",
 "tools": [{"type": "function", "name": "add_note", "parameters": {...}}]}
```

The model's call carries both names: `{"type": "function_call", "namespace": "mcp__notes", "name": "add_note", ...}`.

## In educodex

- [`tools/specs.py`](../../src/educodex/core/tools/specs.py) holds the specs, copied field by field from Codex. `apply_patch_spec()` loads the vendored grammar `vendor/codex/apply_patch.lark`.
- [`tools/registry.py`](../../src/educodex/core/tools/registry.py) turns a call item into a `ToolCall`. Function arguments get parsed, freeform input stays text, and namespaced names are joined:

```python
if item["type"] == "custom_tool_call":
    return cls(item, item["name"], item["call_id"], {}, item.get("input", ""))
try:
    args = json.loads(item.get("arguments") or "{}")
except json.JSONDecodeError as err:
    args = {"__parse_error__": str(err)}
name = f"{item['namespace']}__{item['name']}" if item.get("namespace") else item["name"]
```

- `ToolRouter.dispatch` returns errors as text, with Codex's wording: `unsupported call: <name>` for an unknown function tool, `unsupported custom tool call: <name>` for an unknown freeform tool, `failed to parse function arguments: ...` for bad JSON. A handler raises `ToolError` for failures the model should see.
- [`items.py`](../../src/educodex/core/items.py) `tool_output` picks the output type from the call type:

```python
output_type = "custom_tool_call_output" if call["type"] == "custom_tool_call" else "function_call_output"
return {"type": output_type, "call_id": call["call_id"], "output": output}
```

- [`history.py`](../../src/educodex/core/history.py) `normalize` adds `"aborted"` outputs for dangling calls and drops orphan outputs.
- [`mcp/manager.py`](../../src/educodex/core/mcp/manager.py) `_namespace_spec` builds the namespace spec.

## In Codex

- [`ToolSpec`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/tools/src/tool_spec.rs#L22) in `tools/src/tool_spec.rs` is the enum of tool kinds. `Function` serialises as `"function"`, `Namespace` as `"namespace"`, `Freeform` as [`"custom"`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/tools/src/tool_spec.rs#L54).
- [`FreeformTool`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/tools/src/responses_api.rs#L17), [`ResponsesApiTool`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/tools/src/responses_api.rs#L33) and [`ResponsesApiNamespace`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/tools/src/responses_api.rs#L59) in `tools/src/responses_api.rs` are the wire shapes. The default namespace description `Tools in the {name} namespace.` is [here](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/tools/src/responses_api.rs#L69).
- [`create_apply_patch_freeform_tool`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/handlers/apply_patch_spec.rs#L9) builds `apply_patch` from [`core/assets/tools/apply_patch.lark`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/assets/tools/apply_patch.lark).
- [`exec_command`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/handlers/shell_spec.rs#L96) is defined in `core/src/tools/handlers/shell_spec.rs`.
- The call and output items: [`FunctionCall`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/models.rs#L1076) (with a comment on why `arguments` stays a string), [`FunctionCallOutput`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/models.rs#L1116), [`CustomToolCall`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/models.rs#L1136), [`CustomToolCallOutput`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/models.rs#L1157).
- [`ToolRouter::build_tool_call`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/router.rs#L246) turns an item into a call, keeping `namespace` and `name`.
- [`function_tool_response`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/context.rs#L578) picks `custom_tool_call_output` for custom calls, else `function_call_output`.
- Error texts: [`parse_arguments`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/handlers/mod.rs#L86) and [`unsupported_tool_call_message`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/registry.rs#L888).
- [`normalize.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/context_manager/normalize.rs#L64) inserts the `"aborted"` output for a call without one.

## Where educodex is simpler

- **Text outputs only.** Codex outputs can also be a list of content items (text and images) plus a `success` flag. educodex always sends a string.
- **Fewer tool kinds.** No `web_search`, `tool_search` or `defer_loading` (tools loaded on demand).
- **No streamed tool input.** The API streams tool arguments as they are written (`response.custom_tool_call_input.delta`). Codex uses these to show a patch while it is being written. educodex waits for the finished item.
- **No `environment_id` in the patch grammar.** Codex adds it when one session spans several machines.

## Try it

Ask for a file edit, so the model uses the freeform tool:

```bash
uv run educodex exec "Create notes.txt containing the word hello"
```

The `tool call apply_patch` line shows the raw patch text, not JSON. With `-v` you also see the trace events. In the second request body, look for a `custom_tool_call` and a `custom_tool_call_output` with the same `call_id`:

```bash
uv run educodex exec -v "Create notes.txt containing the word hello"
```

In the web UI (`uv run educodex app-server`, then http://127.0.0.1:8765):
- the **Tools** tab shows every spec as sent. Expand `apply_patch` to see the grammar, and `exec_command` to see its JSON Schema;
- the **Requests** tab shows the call and output items in each later request.

Offline, add `--fake-model examples/fake/demo.json` to `exec` or `app-server`. It replays a script with function calls (`update_plan`, `exec_command`) and a `custom_tool_call` (`apply_patch`). Read [`examples/fake/demo.json`](../../examples/fake/demo.json) to see what the "model" sends.

## Further reading
- [Function calling guide](https://platform.openai.com/docs/guides/function-calling): OpenAI's guide, including custom tools and grammars.
- [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents): names, descriptions and errors written for a model.
- [Edit formats](https://aider.chat/docs/more/edit-formats.html): why the shape of the edit tool changes results.
- [Understanding JSON Schema](https://json-schema.org/understanding-json-schema/) and [Lark grammar reference](https://lark-parser.readthedocs.io/en/latest/grammar.html).
