# 04 — Tools

Read [educodex chapter 03, Tool calling](../educodex/03-tool-calling.md), and [chapter 07, Built-in tools](../educodex/07-built-in-tools.md) first. They explain how a model asks for a tool, how the answer goes back, and Codex's tools. This chapter shows pi's four default tools, how pi runs several tool calls at once, and how both differ from Codex.

## Concept

### Four tools: read, bash, edit, write

pi gives the model four tools by default:

| Tool | Arguments | What it does | The model reads |
|---|---|---|---|
| `read` | `path`, `offset?`, `limit?` | the lines of a text file, at most 2000 lines or 50KB | the lines, then a hint such as `[2 more lines in file. Use offset=4 to continue.]` |
| `bash` | `command`, `timeout?` (seconds) | runs one command in the working directory; stdout and stderr together | the **last** 2000 lines or 50KB, `(no output)`, or the output plus `Command exited with code N` |
| `edit` | `path`, `edits: [{oldText, newText}]` | exact text replacements in one file | `Successfully replaced N block(s) in <path>.` |
| `write` | `path`, `content` | creates or overwrites a file, and its folders | `Successfully wrote to <path>` |

The schemas are [typebox](https://github.com/sinclairzx81/typebox) objects. typebox builds plain JSON Schema, so the same object is sent to the model and used to check the model's arguments:

```ts
const readSchema = Type.Object({
  path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});
// JSON: {"type":"object","required":["path"],"properties":{"path":{...},"offset":{...},"limit":{...}}}
```

pi also has `grep`, `find` and `ls`, off by default. Without them, the system prompt says "Use bash for file operations like ls, rg, find" (chapter 03).

### What the model reads and what the user sees

A tool returns two things: `content`, which goes to the model, and `details`, which only the user interface gets. The edit tool is the clearest case. The model reads one line. The user sees a diff:

```
 1 def greet():
-2     print('hi')
+2     print('hello from edupi')
 3
 4 greet()
```

Each line is `+NN` (added, the line number in the new file), `-NN` (removed, the old line number) or ` NN` (context). At most 4 context lines are shown next to a change; ` ...` stands for the skipped ones. `details` also has a standard unified `patch` and the `firstChangedLine`.

bash returns its truncation and the path of the full output in `details`. `read` and `bash` also return `structuredContent` (the text, or `{output, exit_code, ...}`) for programs that call tools. Neither goes to the model.

### edit: exact text, matched against the original

The model sends one or more replacements for one file. pi's rules, all checked before the file changes:

- Every `oldText` must be found in the file, exactly, and only once. Otherwise the call fails with a message that tells the model what to do: `Could not find the exact text in app.py. The old text must match exactly including all whitespace and newlines.` or `Found 2 occurrences of the text in app.py. The text must be unique. Please provide more context to make it unique.`
- All `oldText`s are matched against the **original** file, not one after the other. So two edits must not overlap.
- The file keeps its byte-order mark and its line endings (`\r\n` stays `\r\n`).

Models get the shape wrong in a few common ways. `prepareArguments` repairs them before the schema check: `edits` sent as a JSON string, one edit object instead of an array, or `oldText`/`newText` at the top level.

### A tool call, step by step

For each tool call in the model's reply, pi's agent loop:

1. emits `tool_execution_start {toolCallId, toolName, args}`;
2. finds the tool (`Tool grep not found` if there is none), repairs the arguments, and checks them against the schema. A failure is a result, not a crash: `Validation failed for tool "read":\n  - path: must have required properties path ...`;
3. calls `execute(toolCallId, args, signal, onUpdate)`. Each `onUpdate(partialResult)` becomes `tool_execution_update`. bash sends one with empty content at the start, then the tail of its output at most every 100 ms;
4. emits `tool_execution_end {result, isError, durationMs}`. A thrown error becomes a result whose text is the error message, with `isError: true`;
5. emits the `toolResult` message (`message_start`, `message_end`), which goes into the context and the session file.

Then the loop calls the model again with the results. A reply without tool calls ends the run.

### Parallel by default

pi runs all tool calls of one reply **at the same time**. The events show it:

```
tool_execution_start slow        ← all calls start first, in call order
tool_execution_start fast
tool_execution_end   fast        ← each call ends when it is done
tool_execution_end   slow
message_end toolResult slow      ← the results follow in call order
message_end toolResult fast
turn_end
```

The `tool_execution_end` events come in completion order, but the result messages come in the order the model asked. So the next request is the same, whichever tool was faster.

`toolExecution: "sequential"` on the `Agent` turns this off: each call starts, ends and gets its result message before the next one starts. A tool can also say `executionMode: "sequential"`: then the whole batch runs one by one. None of pi's four tools does. pi protects files another way: `edit` and `write` wait in a per-file queue, so two edits of one file never overlap.

### Tools are declared in the transcript

pi does not pass the tools beside the messages. They are part of the transcript: a system message carries `toolsAdded` (and, when tools change, `toolsRemoved`). Before the first prompt, the agent loop compares the tools it can run with the tools the transcript declares and adds a system message for the difference (`declareToolChanges`):

```json
{"role": "system", "content": "", "toolsAdded": [{"name": "read", "description": "Read the contents of a file. ...", "parameters": {...}}, ...]}
```

This message is in the RPC events (`message_start` and `message_end` with role `system`) and in the session file. When a session is reopened, its tools are already declared, so nothing is added. The provider replays the system messages to find the current tools and sends them as Chat Completions function specs:

```json
"tools": [{"type": "function", "function": {"name": "read", "description": "...", "parameters": {"type": "object", "required": ["path"], ...}}}, ...]
```

### Tool calls on the Chat Completions wire

The reply streams each call as `tool_calls` deltas: the first delta of a call has its `index`, `id` and `function.name`, the next ones only pieces of `function.arguments` (JSON text). pi joins the pieces per `index` (`toolcall_start`, `toolcall_delta`, `toolcall_end`) and parses the JSON at the end. Text that is not a JSON object becomes an `argumentsError`, which the schema check reports back to the model.

In the next request the assistant message carries the calls, and each result is a `tool` message with plain-text content:

```json
{"role": "assistant", "content": null, "tool_calls": [
  {"id": "call_1", "type": "function", "function": {"name": "bash", "arguments": "{\"command\":\"echo hi\"}"}},
  {"id": "call_2", "type": "function", "function": {"name": "read", "arguments": "{\"path\":\"a.txt\"}"}}]},
{"role": "tool", "content": "hi\n", "tool_call_id": "call_1"},
{"role": "tool", "content": "file a\n", "tool_call_id": "call_2"}
```

This is the request the real pi sent (`test/fixtures/pi/tools-request.json`). An error result is the same kind of message: Chat Completions has no error flag, so the model sees only the text.

## In edupi

| File | Mirrors (pi) | What it does |
|---|---|---|
| [`src/coding-agent/core/tools/index.ts`](../../../backends/edupi/src/coding-agent/core/tools/index.ts) | `coding-agent/src/core/tools/index.ts` | `createCodingTools(cwd)`: read, bash, edit, write |
| [`src/coding-agent/core/tools/read.ts`](../../../backends/edupi/src/coding-agent/core/tools/read.ts) | `tools/read.ts` | The read tool, offset and limit, the continuation hints |
| [`src/coding-agent/core/tools/bash.ts`](../../../backends/edupi/src/coding-agent/core/tools/bash.ts) | `tools/bash.ts` | The bash tool: spawn, kill the process group on abort or timeout, partial output, the temp file |
| [`src/coding-agent/core/tools/edit.ts`](../../../backends/edupi/src/coding-agent/core/tools/edit.ts), [`edit-diff.ts`](../../../backends/edupi/src/coding-agent/core/tools/edit-diff.ts) | `tools/edit.ts`, `tools/edit-diff.ts` | The edit tool, `prepareArguments`, the match rules and pi's diff |
| [`src/coding-agent/core/tools/write.ts`](../../../backends/edupi/src/coding-agent/core/tools/write.ts) | `tools/write.ts` | The write tool |
| [`src/coding-agent/core/tools/truncate.ts`](../../../backends/edupi/src/coding-agent/core/tools/truncate.ts) | `tools/truncate.ts` | `truncateHead` (read), `truncateTail` (bash): 2000 lines or 50KB |
| [`src/agent/agent-loop.ts`](../../../backends/edupi/src/agent/agent-loop.ts) | `agent/src/agent-loop.ts` | `runLoop` (call the model again after tools), `declareToolChanges`, `executeToolCalls` (parallel or sequential), `prepareToolCall`, `executePreparedToolCall` |
| [`src/agent/types.ts`](../../../backends/edupi/src/agent/types.ts) | `agent/src/types.ts` | `AgentTool`, `AgentToolResult`, the `tool_execution_*` events, `AgentProbe` |
| [`src/ai/utils/validation.ts`](../../../backends/edupi/src/ai/utils/validation.ts) | `ai/src/utils/validation.ts` | `validateToolArguments` with typebox |
| [`src/ai/utils/transcript.ts`](../../../backends/edupi/src/ai/utils/transcript.ts) | `ai/src/utils/transcript.ts` | `getCurrentTools`, `getToolStateChanges` |
| [`src/ai/api/openai-completions.ts`](../../../backends/edupi/src/ai/api/openai-completions.ts) | `ai/src/api/openai-completions.ts` | `tool_calls` deltas, `convertTools`, assistant `tool_calls` and `tool` messages |

The heart of parallel execution, in edupi's code. The first loop starts each call; the calls that are ready become functions, and `Promise.all` runs them together:

```ts
for (const toolCall of toolCalls) {
  await emit({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments });
  const preparation = prepareToolCall(currentContext, toolCall, signal);
  if (preparation.kind === "immediate") { /* unknown tool or bad arguments: end at once */ continue; }
  finalizedCalls.push(async () => {
    const finalized = { toolCall, ...(await executePreparedToolCall(preparation, signal, emit)) };
    await emitToolExecutionEnd(finalized, emit, config); // completion order
    return finalized;
  });
}
const orderedFinalizedCalls = await Promise.all(finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : entry)));
for (const finalized of orderedFinalizedCalls) await emitToolResultMessage(createToolResultMessage(finalized), emit); // call order
```

**Teaching extras.** The agent loop calls two probe hooks, `toolDispatch` (after `tool_execution_start`) and `toolOutput` (after `tool_execution_end`). The tracer turns them into the shared trace events `toolDispatch` and `toolOutput` (`protocol/README.md` section 6), and sends `toolsRegistered` with the tool specs before the first request. The **Tools** tab shows the specs and each call with the text the model read back. In the chat, `bash` is a shell card, `edit` a diff card (the pi adapter's `editDiff` part, from `details.diff`), `read` and `write` generic tool cards.

The tests in [`test/rpc-tools.test.ts`](../../../backends/edupi/test/rpc-tools.test.ts) script tool calls with the faux provider and run the tools for real in a temporary folder. They check each tool, failing calls, the parallel event order, the request against the real pi's request, and the trace events.

## In pi

- The tools: [`createCodingTools`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/tools/index.ts#L195), [`read`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/tools/read.ts#L86), [`bash`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/tools/bash.ts#L243) and its [process code](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/tools/bash.ts#L97), [`edit`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/tools/edit.ts#L143) with [`prepareEditArguments`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/tools/edit.ts#L103), [`write`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/tools/write.ts#L44).
- Edits and diffs: [`applyEditsToNormalizedContent`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/tools/edit-diff.ts#L300), [`fuzzyFindText`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/tools/edit-diff.ts#L207), [`generateDiffString`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/tools/edit-diff.ts#L376).
- Truncation: [the limits](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/tools/truncate.ts#L11), [`truncateHead`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/tools/truncate.ts#L78), [`truncateTail`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/tools/truncate.ts#L168); the bash update throttle [`BASH_UPDATE_THROTTLE_MS`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/tools/renderers/bash.ts#L19).
- The agent loop: [`runLoop`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/agent-loop.ts#L163), [`declareToolChanges`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/agent-loop.ts#L333), [`failToolCallsFromTruncatedMessage`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/agent-loop.ts#L478), [`executeToolCalls`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/agent-loop.ts#L508), [sequential](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/agent-loop.ts#L530) and [parallel](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/agent-loop.ts#L586), [`prepareToolCall`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/agent-loop.ts#L708), [`executePreparedToolCall`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/agent-loop.ts#L821), [`createToolResultMessage`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/agent-loop.ts#L930); the default [`toolExecution = "parallel"`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/agent.ts#L253).
- Types: [`AgentToolResult`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/types.ts#L424), [`AgentTool`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/types.ts#L466), [the tool events](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/types.ts#L529).
- The provider: [`validateToolArguments`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/utils/validation.ts#L317), [`getCurrentTools`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/utils/transcript.ts#L58), [the `tool_calls` deltas](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/api/openai-completions.ts#L655), [assistant `tool_calls`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/api/openai-completions.ts#L1368), [`tool` messages](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/api/openai-completions.ts#L1414), [`convertTools`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/api/openai-completions.ts#L1490).

## How Codex does it differently

| | pi | Codex |
|---|---|---|
| Default tools | `read`, `bash`, `edit`, `write` | `exec_command`, `write_stdin`, `apply_patch`, `update_plan` (chapter 07) |
| Reading a file | its own `read` tool, with offset and limit | a shell command (`cat`, `sed -n`, `rg`) through `exec_command` |
| Running a command | `bash` waits until the command ends (or its timeout) | `exec_command` returns after `yield_time_ms`; a long command keeps running as a session, polled with `write_stdin` |
| Changing a file | `edit`: exact `oldText` → `newText` replacements, or `write` the whole file | `apply_patch`: one freeform patch in Codex's own format, for many files at once |
| Long output | the head (read) or the tail (bash), whole lines; bash saves the full output to a temp file and names it | the head and the tail, the middle cut out, with a token count |
| Output text | the plain output, plus status lines (`Command exited with code 3`) | a header: `Chunk ID`, `Wall time`, `Process exited with code`, `Original token count`, then `Output:` |
| Parallel calls | every call of one reply runs at once, unless a tool says sequential | a read/write lock: parallel-safe tools (`exec_command`, read-only MCP tools) share it, the others (`apply_patch`) run alone |
| Where the tools are | in the transcript (system message `toolsAdded`), sent as Chat Completions `tools` | in the request's `tools` field (or, for Responses Lite models, an `additional_tools` input item) |
| Results on the wire | `tool` messages with `tool_call_id` | `function_call_output` / `custom_tool_call_output` items with `call_id` |
| Safety | none: the tools run with the user's rights (pi has no approvals or sandbox) | approval policy, command rules and an OS sandbox (chapters 09 to 11) |

The biggest difference is the **edit format**. Codex teaches the model a patch language and has a parser for it. pi asks for the old text and the new text and needs only `indexOf`: simpler for the harness, but the old text must be exact and unique, so the model often sends more context than the change.

The second is **parallelism**. pi trusts the model: a reply's calls all run at once, and only the per-file queue keeps edits of one file in order. Codex decides per tool: a tool is serial unless it says it is safe. In pi the default is parallel; in Codex the default is serial.

The Codex side: [`ToolCallRuntime`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/parallel.rs#L46) and its [read or write lock](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/parallel.rs#L211), the [serial default](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/tools/src/tool_executor.rs#L122), [`exec_command` is parallel-safe](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs#L142). educodex's version is in [chapter 04](../educodex/04-agentic-loop.md) and [chapter 07](../educodex/07-built-in-tools.md).

## Where edupi is simpler

- **No fuzzy match in edit.** pi tries the exact text first, then a normalised match (no trailing spaces, straight quotes, ASCII dashes). edupi matches exact text only.
- **No file mutation queue.** pi lets one `edit` or `write` per file run at a time. In edupi two parallel edits of one file can race.
- **No images.** pi's `read` sends images as attachments (resized); edupi reads every file as text.
- **Simpler bash.** No `PI_*` environment variables (session id, model, thinking level), no spawn hook or command prefix, no Windows shells. The output is kept in memory (pi streams it to the temp file), and `structuredContent.output` is not capped at 1MB. After the command exits, edupi waits at most 100 ms for the output pipes; pi waits until they are idle.
- **Simpler paths.** No macOS file-name variants (NFD, curly quotes, screenshot names) in `read`.
- **No `beforeToolCall` / `afterToolCall` hooks** (pi uses them for extensions), no `terminate` flag, no `grep`, `find` and `ls` tools, no tool set changes after the first prompt (so no `toolsRemoved` in practice).
- **Simpler argument parsing.** While a call streams, edupi shows its arguments only once the JSON so far parses; pi uses a partial-JSON parser and repairs bad string escapes.

## Try it

In the web UI, open **edupi** (with a real model) and ask: *"Create notes.txt with three lines, then read it back, then change the second line."* Watch the **Timeline**: `tool_execution_start`, `tool_execution_update` (for bash), `tool_execution_end`, then the `toolResult` messages. Open the **Tools** tab to see the four specs and each call's output. The edit card in the chat shows the diff.

Ask for two slow commands at once: *"Run `sleep 2; echo a` and `sleep 1; echo b` as two separate bash calls in one reply."* The `tool_execution_end` of `b` comes first; the `toolResult` of `a` still comes first.

Offline, over stdio, with the faux script that writes, runs and edits a file:

```bash
EDUPI=$PWD; mkdir -p /tmp/edupi-tools && cd /tmp/edupi-tools   # the tools work in the current directory
node $EDUPI/bin/edupi.mjs --mode rpc --no-session \
  --faux $EDUPI/examples/faux/tools.json --faux-log /tmp/edupi-tools.requests.jsonl
{"id":"1","type":"prompt","message":"Go."}
```

Then read the second request the faux provider got, and find the `tool_calls` and the `tool` messages:

```bash
sed -n 2p /tmp/edupi-tools.requests.jsonl | jq '.body.messages[-3:]'
```

Run the tests:

```bash
npx vitest run test/rpc-tools.test.ts
```

## Further reading

- OpenAI, [Function calling](https://platform.openai.com/docs/guides/function-calling) (Chat Completions `tools`, `tool_calls` and `tool` messages, parallel function calling).
- OpenRouter, [Tool calling](https://openrouter.ai/docs/features/tool-calling).
- [typebox](https://github.com/sinclairzx81/typebox): JSON Schema types for TypeScript.
- pi's [`docs/cli.md`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/docs/cli.md#L119) (`--tools`): the default tools and how to turn on `grep`, `find` and `ls`.
- [educodex chapter 07](../educodex/07-built-in-tools.md): Codex's tools in detail.
