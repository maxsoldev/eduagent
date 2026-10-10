# 12 — MCP

## Concept

### Tools that live in another program

The built-in tools from chapter 07 are compiled into the harness. But you will also want the agent to read your issue tracker, query a database or drive a browser. Writing each of those into every harness would never end.

The **Model Context Protocol (MCP)** fixes this. It is a standard way for a harness (the *client*) to talk to a separate program (the *server*) that offers tools. You write one notes server, and any MCP-capable harness (Codex, Claude Code, Cursor) can use it.

The simplest setup is **stdio**:
1. The harness starts the server as a child process, e.g. `python examples/mcp/notes_server.py`.
2. They exchange JSON-RPC messages over the child's stdin and stdout, one per line.
3. After a handshake (`initialize`), the client asks `tools/list` and later calls `tools/call`.

### `tools/list`: what the server offers

Here is one real entry from our demo notes server:

```json
{
  "name": "clear_notes",
  "description": "Delete every note.",
  "inputSchema": {"type": "object", "properties": {}, "title": "clear_notesArguments"},
  "outputSchema": {"type": "object", "properties": {"result": {"type": "string", "title": "Result"}},
                   "required": ["result"], "title": "clear_notesOutput"},
  "annotations": {"destructiveHint": true}
}
```

The `annotations` are **hints** from the server about what the tool does:

| Hint | Meaning |
|---|---|
| `readOnlyHint: true` | Only reads; changes nothing |
| `destructiveHint: true` | May delete or overwrite things |
| `openWorldHint: true` | Talks to the outside world (web, other people) |

They are hints, not guarantees. A buggy or hostile server can lie. The harness uses them to decide when to ask the user, but it cannot check them.

### `tools/call`: running one

```json
{"method": "tools/call", "params": {"name": "list_notes", "arguments": {}}}
```

The server answers with a `CallToolResult`:

```json
{
  "content": [{"type": "text", "text": "(no notes)"}],
  "structuredContent": {"result": "(no notes)"},
  "isError": false
}
```

`content` is a list of text, image or audio blocks for humans and models. `structuredContent` is the same answer as JSON that matches `outputSchema`.

### The harness is a translator

The model never speaks MCP. It only sees tool specs in its request (chapter 03). So the harness has to translate in both directions:

```
MCP server                 harness                                 model
tools/list   ──────►  rename, clean schema, group   ──────►  namespace tool "mcp__notes"
tools/call   ◄──────  approval? route by name       ◄──────  function_call {namespace, name}
CallToolResult ────►  pick text, truncate           ──────►  function_call_output
```

Each step has a reason:
- **Names.** The Responses API only accepts tool names made of `[A-Za-z0-9_]`, up to 128 characters. MCP names can contain dots, dashes or slashes.
- **Collisions.** Two servers can both have a `search` tool. Grouping each server under its own **namespace** (`mcp__github`, `mcp__notes`) keeps them apart.
- **Schemas.** MCP allows any JSON Schema. The model API accepts a smaller subset, so the harness rewrites what it can't send.
- **Safety.** The model must not run `clear_notes` without the user saying yes.

### Why the tool list must stay still

The tool list is part of the prompt prefix. Prompt caching (chapter 05) only works if that prefix is byte-for-byte the same on every request. So the harness:
- sorts servers and tools into a fixed order;
- does not rebuild the list in the middle of a session. MCP lets a server send `notifications/tools/list_changed` when its tools change. Codex just logs it.

## In educodex

The MCP code is three small files in [`mcp/`](../../src/educodex/core/mcp/):

| File | Job |
|---|---|
| [`mcp/manager.py`](../../src/educodex/core/mcp/manager.py) | Start servers, `tools/list`, approvals, `tools/call`, result text |
| [`mcp/naming.py`](../../src/educodex/core/mcp/naming.py) | Sanitise names, add the `mcp__` prefix |
| [`mcp/schema.py`](../../src/educodex/core/mcp/schema.py) | Clean up input schemas |

### Discovery and naming

`McpManager.start` starts each server with the official `mcp` SDK, in sorted order "so the tool list (and prompt cache) stays stable", and sorts each server's tools by name. Names go through one regex:

```python
def sanitize(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_]", "_", name) or "_"
```

If two tools of one server sanitise to the same name (`a.b` and `a_b`), `_dedupe` adds `_` plus the first 12 hex characters of a SHA-1 hash.

### What the model sees

This is the real `trace/mcpToolExposed` event for the notes server (two tools shortened):

```json
{
  "type": "namespace",
  "name": "mcp__notes",
  "description": "Tools in the mcp__notes namespace.",
  "tools": [
    {"type": "function", "name": "add_note", "description": "Save a short note.", "strict": false,
     "parameters": {"type": "object", "properties": {"text": {"type": "string", "title": "Text"}},
                    "required": ["text"], "title": "add_noteArguments"}},
    {"type": "function", "name": "clear_notes", "...": "..."},
    {"type": "function", "name": "list_notes", "...": "..."}
  ]
}
```

Compare it with the raw entry above: `outputSchema` and `annotations` are gone (the model doesn't need them), and the tools are grouped under one namespace. When the model calls a tool, the `function_call` item carries both parts, `{"namespace": "mcp__notes", "name": "add_note", ...}`. [`ToolCall.from_item`](../../src/educodex/core/tools/registry.py) joins them into the routing key `mcp__notes__add_note`.

`sanitize_schema` follows Codex's rules: `true`/`false` schemas become `{"type": "string"}`, `const: x` becomes `enum: [x]`, a missing `type` is guessed from other keys (`properties` → object, `items` → array, `enum` → string, `minimum`/`maximum` → number), and objects always get `properties`. A schema with no hint at all stays untyped, so `{}` means "any value", as in Codex.

### Approval from annotations

```python
def needs_approval(annotations: dict[str, Any] | None) -> bool:
    a = annotations or {}
    if a.get("destructiveHint") is True:
        return True
    if a.get("readOnlyHint") is True:
        return False
    return a.get("destructiveHint") is not False or a.get("openWorldHint") is not False
```

A missing hint counts as the risky value. So `add_note`, which has no hints, asks too. Only a tool that is read-only, or explicitly neither destructive nor open-world, runs freely. For the notes server:

| Tool | Hints | Result |
|---|---|---|
| `list_notes` | `readOnlyHint: true` | runs, and may run in parallel with other read-only tools |
| `add_note` | none | asks |
| `clear_notes` | `destructiveHint: true` | asks |

When approval is needed, `McpToolHandler.handle` sends the client a `mcpServer/elicitation/request`. This is MCP's own "ask the user a question" shape. As in Codex's v2 protocol, the fields sit flat in `params`:

```json
{"threadId": "…", "turnId": "…", "serverName": "notes", "mode": "form",
 "message": "Allow the notes MCP server to run tool \"add_note\"?",
 "requestedSchema": {"type": "object", "properties": {}},
 "_meta": {"tool": "add_note", "arguments": {"text": "buy milk"}, "annotations": null}}
```

The form is empty because the only question is yes or no. The client answers `{"action": "accept" | "decline" | "cancel"}`. Under `approval_policy=never` the call is refused, unless the sandbox is `danger-full-access`. Then it is allowed. Chapter 09 explains approval requests in general.

### Result for the model

```python
def model_text(result):
    if result.get("structuredContent") is not None:
        return json.dumps(result["structuredContent"], ensure_ascii=False)
    ...
```

`structuredContent` wins, so for `list_notes` the model reads `{"result": "(no notes)"}`, not the plain text. Then the usual middle truncation from chapter 07 applies. An error result (`isError: true`) is sent the same way, with no `Error:` prefix; the item in the UI is marked `failed`.

### Not sandboxed

The server is a normal child process. `sandbox-exec` (chapter 10) wraps only `exec_command`. An MCP server can read your SSH keys or open network connections, whatever the sandbox mode says. The only guardrail is the approval prompt, and it relies on annotations that the server writes about itself. The module docstring says this too: "MCP servers run outside it and must enforce their own guardrails." That is the "external communication" leg of the lethal trifecta (chapter 11).

## In Codex

| Step | Where in Codex |
|---|---|
| Sanitise names to `[A-Za-z0-9_]` | [`codex-mcp/src/mcp/mod.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/codex-mcp/src/mcp/mod.rs#L578) `sanitize_responses_api_tool_name` |
| Prefix, dedupe, hash, 128-char limit | [`codex-mcp/src/tools.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/codex-mcp/src/tools.rs#L113) `normalize_tools_for_model_with_prefix`; SHA-1 suffix of [12 chars](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/codex-mcp/src/tools.rs#L227) |
| Insert missing `properties` | [`tools/src/mcp_tool.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/tools/src/mcp_tool.rs#L45) |
| Schema cleanup | [`tools/src/json_schema.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/tools/src/json_schema.rs#L80) `sanitize_json_schema` |
| Elicitation params (`serverName` + flattened `mode`, `message`, `requestedSchema`, `_meta`) | [`app-server-protocol/src/protocol/v2/mcp.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/protocol/v2/mcp.rs#L420) `McpServerElicitationRequestParams` |
| One namespace spec per tool | [`core/src/tools/handlers/mcp.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/handlers/mcp.rs#L502) `create_tool_spec` |
| Merge namespaces, sort tools by name | [`core/src/tools/spec_plan.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/spec_plan.rs#L1008) `merge_into_namespaces`; [default description](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/tools/src/responses_api.rs#L65) |
| Read-only tools run in parallel | [`core/src/tools/handlers/mcp.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/handlers/mcp.rs#L142) |
| The call itself | [`core/src/mcp_tool_call.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/mcp_tool_call.rs#L130) `handle_mcp_tool_call` |
| Annotations → approval | [`requires_mcp_tool_approval`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/mcp_tool_call.rs#L2461) |
| `never` + full access auto-approves | [`mcp_permission_prompt_is_auto_approved`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/codex-mcp/src/mcp/mod.rs#L91) |
| Otherwise `never` refuses | [`mcp_tool_call.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/mcp_tool_call.rs#L1615) |
| Elicitation form, prompt text | [`build_mcp_tool_approval_elicitation_request`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/mcp_tool_call.rs#L1975), [fallback message](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/mcp_tool_call.rs#L1956) |
| Parse accept / decline / cancel | [`parse_mcp_tool_approval_elicitation_response`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/mcp_tool_call.rs#L2126) |
| Result → model output | [`protocol/src/models.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/models.rs#L2304) `as_function_call_output_payload` |
| `tools/list_changed` only logged | [`rmcp-client/src/logging_client_handler.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/rmcp-client/src/logging_client_handler.rs#L86) |
| Server = plain child process | [`rmcp-client/src/stdio_server_launcher.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/rmcp-client/src/stdio_server_launcher.rs#L5) |
| Optional sandbox info for servers | [`augment_mcp_tool_request_meta_with_sandbox_state`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/mcp_tool_call.rs#L853) |

A few things worth noticing:
- **Approval modes.** `requires_mcp_tool_approval` is the `auto` mode. Users can set a server or tool to `prompt` (always ask), `writes` (ask unless read-only) or `approve` (never ask). See [`requires_mcp_tool_approval_for_mode`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/mcp_tool_call.rs#L2480). Approvals can also be remembered for the session or saved to config.
- **Elicitation is a feature flag.** `tool_call_mcp_elicitation` is on by default. With it off, Codex asks through `request_user_input` instead.
- **Sandbox handshake.** A server can advertise the `codex/sandbox-state-meta` capability. Codex then sends the current sandbox policy and cwd in each call's `_meta`, so the server can limit itself. Codex itself enforces nothing on the server.
- **Images.** If the model can't take image or audio input, [`sanitize_mcp_tool_result_for_model`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/mcp_tool_call.rs#L948) replaces those blocks with a text note.

## Where educodex is simpler

- **Stdio only.** Codex also supports streamable HTTP servers, OAuth, and starting servers through a remote executor.
- **Dedupe.** educodex only hashes the *second* tool that collides, using its raw name. Codex hashes *every* colliding tool, using its full identity (server, namespace, tool), and also handles colliding namespaces and the 128-character limit.
- **Schemas.** Codex parses the schema into a small typed struct ([`json_schema/types.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/tools/src/json_schema/types.rs#L37)). That drops keys it doesn't know, such as `title`. educodex passes them through (see `"title"` in the JSON above). educodex also skips Codex's schema size budget and unused-`$defs` pruning.
- **Results.** Codex sends `content` blocks as separate `input_text`/`input_image` parts with a success flag. educodex joins the text blocks into one string and has no success flag.
- **Approvals.** educodex only has Codex's `auto` mode. It has no "remember for session", no per-tool config, and no Guardian auto-review.
- **No deferred loading.** With many tools, Codex can hide MCP tools behind `tool_search` (`ToolExposure::Deferred`) so they don't fill the prompt.

## Try it

Ask the agent to use the notes server from the CLI. You will be asked about `add_note` but not `list_notes`:

```bash
uv run educodex exec --mcp notes="python examples/mcp/notes_server.py" \
  "Add a note 'buy milk', then list all notes"
```

Watch for `trace/mcpToolExposed` at the start, then a `policy` line for each call. Notes are stored in `~/.educodex/notes.json`. Set `NOTES_FILE=/tmp/notes.json` to keep them elsewhere.

In the web UI:

```bash
uv run educodex app-server --mcp notes="python examples/mcp/notes_server.py"
```

Open http://127.0.0.1:8765:
1. In the **Tools** tab, put the raw `tools/list` entry next to the exposed namespace spec. What disappeared? What was renamed?
2. Ask "clear all my notes". The chat shows an approval card for the elicitation. Decline it and read what the model gets back.
3. In the **Guardrails** tab, find the `trace/policyDecision` for each call. The reason shows which annotations led to it.
4. Restart with `--approval never` and try `add_note` again. It is refused without a prompt.

## Further reading
- [Model Context Protocol specification](https://modelcontextprotocol.io/specification/latest), especially [Tools](https://modelcontextprotocol.io/specification/latest/server/tools) for annotations and `structuredContent`.
- [Codex MCP docs](https://developers.openai.com/codex/mcp): configuring `[mcp_servers.<name>]` in Codex.
- [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents): naming, namespacing and descriptions, from the server author's side.
- [Prompt caching](https://platform.openai.com/docs/guides/prompt-caching): why a changing tool list costs money.
- [The lethal trifecta for AI agents](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/): why an unsandboxed MCP server is a risk.
