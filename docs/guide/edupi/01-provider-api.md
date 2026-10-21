# 01 — The provider API

Read [educodex chapter 02, Talking to a model](../educodex/02-talking-to-a-model.md) first. It explains requests, roles, tokens, streaming with SSE and stateless requests. This chapter shows what pi does differently.

## Concept

### Two OpenAI APIs

OpenAI has two HTTP APIs for chat models, and other providers copy both:

| | Chat Completions | Responses |
|---|---|---|
| Endpoint | `POST /chat/completions` | `POST /responses` |
| History | `messages`: a list of `{role, content}` | `input`: a list of typed items |
| Tool calls | inside the assistant message: `tool_calls[]` | separate `function_call` items |
| Tool results | `{role: "tool", tool_call_id, content}` messages | `function_call_output` items |
| Reasoning | provider-specific fields (`reasoning`, `reasoning_content`, ...) | `reasoning` items with `encrypted_content` |
| Stream | `chat.completion.chunk` deltas | named events (`response.output_text.delta`, ...) |

Chat Completions is older and simpler. Almost every provider and proxy accepts it, so it is the common language of the model world. Codex uses only Responses. pi supports both, and many more provider APIs. edupi uses only Chat Completions, as pi does for OpenRouter.

### OpenRouter is an OpenAI-compatible endpoint

[OpenRouter](https://openrouter.ai/docs/quickstart) routes one request to many model providers (OpenAI, Anthropic, Google, open models). It accepts the OpenAI Chat Completions format at `https://openrouter.ai/api/v1/chat/completions`. So the official OpenAI SDK works with it: you only change the base URL and the key.

```ts
const client = new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: "https://openrouter.ai/api/v1" });
const stream = await client.chat.completions.create({ model: "openai/gpt-6-luna", messages, stream: true });
```

Model ids name the provider and the model: `openai/gpt-6-luna`, `anthropic/claude-sonnet-5`. One code path reaches every model family. OpenRouter adds a few fields of its own, for example one `reasoning: {effort}` object for every model family ([chapter 02](02-loop-and-queues.md#thinking-level)).

### A request

This is the body edupi sends for its first prompt, recorded by the faux provider (see "Try it"), shortened:

```json
{
  "model": "openai/gpt-6-luna",
  "messages": [
    {"role": "system", "content": "You are an expert coding assistant operating inside pi, ..."},
    {"role": "user", "content": [{"type": "text", "text": "Say hello."}]}
  ],
  "stream": true,
  "stream_options": {"include_usage": true},
  "store": false,
  "max_completion_tokens": 16384,
  "tools": [{"type": "function", "function": {"name": "read", "description": "...", "parameters": {...}}}, ...]
}
```

The system prompt ([chapter 03](03-prompt-assembly.md)) and the tools ([chapter 04](04-tools.md)) come from system messages in the transcript.

- The request is stateless, as in Codex: the second request carries the first question and answer again. `store: false` asks the server to keep nothing.
- `stream_options.include_usage` asks for one last chunk with the token counts.
- Assistant text goes back as a plain string: `{"role": "assistant", "content": "First answer."}`.

### A streamed reply

The server sends SSE lines. Each `data:` line is a `chat.completion.chunk` (shortened below). The first chunk names the role, the next ones carry text deltas, one chunk has the `finish_reason`, and the last one has `usage` and no `choices`:

```
data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}
data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"Hello from t"}}]}
data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"he faux model."}}]}
data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":17,"completion_tokens":7,"total_tokens":24}}
data: [DONE]
```

Compare this with the Responses stream in educodex chapter 02. Chat Completions has no "item done" event: the client must build the final message from the deltas itself.

### pi's own message format

pi does not keep Chat Completions messages in its history. Its provider layer (`packages/ai`) has **one message format for every provider**: `user`, `assistant` (with `text`, `thinking` and `toolCall` content blocks), `toolResult` and `system` messages. Each provider API converts this format to its wire format before a request, and turns the stream back into **AssistantMessageEvents**:

```
start → text_start → text_delta* → text_end → done      (or error)
```

So the agent loop never sees SSE, chunks or provider fields. This is why pi can switch a session from one provider to another between two requests.

## In edupi

| File | Mirrors (pi) | What it does |
|---|---|---|
| [`src/ai/types.ts`](../../../backends/edupi/src/ai/types.ts) | `packages/ai/src/types.ts` | Messages, content blocks, `Usage`, `Model`, `AssistantMessageEvent` |
| [`src/ai/utils/event-stream.ts`](../../../backends/edupi/src/ai/utils/event-stream.ts) | `packages/ai/src/utils/event-stream.ts` | `AssistantMessageEventStream`: a queue the loop reads with `for await`, plus `result()` |
| [`src/ai/api/openai-completions.ts`](../../../backends/edupi/src/ai/api/openai-completions.ts) | `packages/ai/src/api/openai-completions.ts` | The Chat Completions API |
| [`src/ai/providers/openrouter.ts`](../../../backends/edupi/src/ai/providers/openrouter.ts) | `packages/ai/src/providers/openrouter.ts` | OpenRouter's base URL, key variable and models |
| [`src/ai/providers/faux.ts`](../../../backends/edupi/src/ai/providers/faux.ts) | `packages/ai/src/providers/faux.ts` | The scripted test model |

`stream()` in `openai-completions.ts` does pi's steps in pi's order:

1. Make an empty assistant message with `stopReason: "pending"`.
2. `createClient`: an OpenAI SDK client with OpenRouter's base URL. With a session id it adds `x-session-id`, so OpenRouter sends the session's requests to the same upstream (warm prompt cache). A request with `cacheRetention: "none"` (a compaction summary, [chapter 07](07-compaction.md)) gets no such header.
3. `buildParams`: the body above. `convertMessages` turns pi messages into Chat Completions messages. System messages become `developer` messages for reasoning models that support it, else `system`.
4. `client.chat.completions.create(params, {signal, maxRetries: 0})`, then push `start`.
5. For each chunk: keep the response id and usage, map `finish_reason` (`stop` → `stop`, `tool_calls` → `toolUse`, `length` → `length`, anything else → error), turn `delta.content` into `text_start` / `text_delta`, and `delta.tool_calls` into `toolcall_start` / `toolcall_delta` (chapter 04).
6. After the last chunk: `text_end` or `toolcall_end` (with the parsed arguments) for each block, then `done`. A stream without `finish_reason` is an error.
7. Any exception becomes an `error` event with `stopReason: "error"` (or `"aborted"`). `stream()` never throws, so the loop has one way to see failures. The text is pi's `formatProviderError`: for an HTTP error the status and the error body, for example `400: {"message":"Invalid model","code":400}`. Unfinished blocks lose their stream buffers first, so a broken stream never persists them.

`streamSimple()` is what the agent calls. It fills request options from the model (`maxTokens`), clamps the thinking level to the model and passes it on as the reasoning effort, then calls `stream()`.

Two small text fixes run on the way, as in pi: `convertMessages` removes unpaired UTF-16 surrogates (half an emoji) from the text it sends (`sanitizeSurrogates`), and finished tool-call arguments with raw control characters or bad escapes in a string are repaired before they are parsed (`repairJson`). When the arguments are validated, a `null` for an optional argument counts as left out (`normalizeOptionalNulls` in `utils/validation.ts`).

**The faux provider.** pi's tests use a faux provider: you queue assistant messages, and each request streams the next one back in random chunks of 3 to 5 "tokens" (4 characters each). edupi keeps that idea, but fakes the HTTP endpoint instead of the whole provider. `fauxProvider().fetch` is passed to the OpenAI SDK, and it answers each request with the Chat Completions SSE chunks for the next scripted message. So in tests the real `openai-completions.ts` code runs, and every request body can be recorded. `--faux script.json` turns it on; `--faux-log file.jsonl` writes one `{url, body}` line per request. A script is `{"responses": ["a text reply", {"content": [...], "stopReason": "stop"}]}`; a content block is `{"type": "text", "text"}`, `{"type": "thinking", "thinking"}` (streamed as `reasoning` deltas) or `{"type": "toolCall", "id", "name", "arguments"}` (streamed as `tool_calls` deltas, with `"stopReason": "toolUse"`). `"tokensPerSecond": n` slows the stream down, so a test can steer or abort while it runs. For error paths: `{"error": {"status", "message"}}` is an HTTP error, `"streamError": "text"` on a reply breaks its stream before the finish chunk, and `"rawArguments": "text"` on a tool call streams that text instead of the JSON of `arguments`.

The tests in [`test/rpc-provider.test.ts`](../../../backends/edupi/test/rpc-provider.test.ts) check the recorded bodies.

**Trace events.** pi does not show its requests to an RPC client. edupi adds teaching hooks, as educodex does: the provider calls an optional `probe` in the stream options (`ProviderProbe` in `src/ai/types.ts`) with the exact body after `buildParams`, with each raw chunk, and with the final message. The core only calls these hooks. The tracer in [`src/observe/tracer.ts`](../../../backends/edupi/src/observe/tracer.ts) implements them and writes `{"type": "trace", "name": "modelRequest" | "streamEvent" | "modelResponse", ...}` lines next to pi's events. The names and payloads are shared with educodex ([protocol spec, section 6](../../../protocol/README.md#6-trace-events)); `modelRequest` names its API, `openai-completions`, so the viewer draws the request as Chat Completions messages. [`test/rpc-trace.test.ts`](../../../backends/edupi/test/rpc-trace.test.ts) checks the traces against the bodies the faux provider recorded.

## In pi

- [`stream`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/api/openai-completions.ts#L304) in `packages/ai/src/api/openai-completions.ts` is the main function. [`streamSimple`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/api/openai-completions.ts#L738), [`createClient`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/api/openai-completions.ts#L759), [`buildParams`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/api/openai-completions.ts#L804), [`convertMessages`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/api/openai-completions.ts#L1197) (the [`developer` or `system` choice](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/api/openai-completions.ts#L1239)), [`parseChunkUsage`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/api/openai-completions.ts#L1527) and [`mapStopReason`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/api/openai-completions.ts#L1570) are in the same file. OpenRouter's [`reasoning` field](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/api/openai-completions.ts#L942) is one of many reasoning formats pi supports.
- Errors and text fixes: [the `catch` block](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/api/openai-completions.ts#L709) of `stream`, [`normalizeProviderError`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/utils/error-body.ts#L38) and [`formatProviderError`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/utils/error-body.ts#L128), [`sanitizeSurrogates`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/utils/sanitize-unicode.ts#L21), [`repairJson`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/utils/json-parse.ts#L33).
- [`OPENROUTER_BASE_URL`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/providers/openrouter.ts#L13) and [`openrouterProvider`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/providers/openrouter.ts#L62): OpenRouter offers two APIs in pi, `openai-completions` and `anthropic-messages` (for Claude models).
- The stream types: [`AssistantMessageEvent`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/types.ts#L790) with the protocol rules in its comment, and [`AssistantMessageEventStream`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/utils/event-stream.ts#L97).
- The faux provider: [`fauxAssistantMessage`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/providers/faux.ts#L78), [`streamWithDeltas`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/providers/faux.ts#L356), [`createFauxCore`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/providers/faux.ts#L454).

## How Codex does it differently

- **One API, Responses.** Codex's [`build_responses_request`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/client.rs#L891) builds a Responses body, and its history is a list of Responses items (educodex chapter 02). pi's history is in its own format, and each request converts it. Codex's history *is* the wire format.
- **Reasoning travels differently.** Codex sends reasoning back as `encrypted_content` items. Chat Completions has no standard field for this; OpenRouter streams `reasoning` text and `reasoning_details`, and pi keeps them in a `thinking` block's `thinkingSignature` for replay.
- **Models.** Codex has a model catalog (`models.json`) that decides prompts and tools per model (educodex chapter 06). pi's catalog has only limits, prices and capability flags, and the same prompt is used for every model.
- **Both use OpenRouter in eduagent.** educodex calls OpenRouter's Responses endpoint, edupi its Chat Completions endpoint, with the same default model.

## Where edupi is simpler

- **One API, one provider.** pi has more than ten provider APIs (Anthropic Messages, Google, Bedrock, Mistral, ...) and a registry that picks one by `model.api`. edupi calls `openai-completions` directly.
- **Model metadata from OpenRouter at start.** pi ships a catalog generated from OpenRouter's `GET /models` and refreshes it in the background. edupi reads the same list once when it starts ([`model-registry.ts`](../../../backends/edupi/src/coding-agent/core/model-registry.ts), mapped as pi's generator maps it in [`openrouter.ts`](../../../backends/edupi/src/ai/providers/openrouter.ts)): context window, output limit, prices, the `reasoning` flag and the **thinking level map**. pi builds the map from the model's `reasoning.supported_efforts` (`getOpenRouterThinkingLevelMap`): each level maps to the same effort, or to `null` if the model does not list it; `off` maps to `"none"`, or to `null` when `reasoning.mandatory` is true (then no `reasoning` field is sent for `off`). The map decides which thinking levels a model supports and which effort goes into the request ([chapter 02](02-loop-and-queues.md#thinking-level)). A model the list does not have, or a start with `--offline`, gets the defaults of pi's `models.json` (`contextWindow: 128000`, `maxTokens: 16384`, no reasoning). In tests the faux provider answers `GET /models` from the script's `models`. A reasoning model gets the `developer` role and the `reasoning` field ([chapter 02](02-loop-and-queues.md#thinking-level)).
- **Reasoning text only.** Reasoning deltas (`reasoning_content`, `reasoning`, `reasoning_text`) become a thinking block and go back in the same field. OpenRouter's structured `reasoning_details` are not kept.
- **No retries.** pi retries some provider errors (`retryProviderRequest`); edupi calls once.
- **No `max_completion_tokens` clamp.** pi lowers it so that the prompt plus the answer fit in the context window. edupi sends the model's `maxTokens`.
- **Fewer compat switches.** pi detects about twenty differences between OpenAI-compatible servers (`detectCompat`). edupi keeps only OpenRouter's values. So it also leaves out pi's handling of other servers' quirks: usage inside `choices[0]`, other cached-token fields, tool-call deltas without an `index` (pi matches them by id), non-object chunks.
- **No Anthropic prompt caching.** For `anthropic/` models pi uses OpenRouter's Anthropic Messages API, and adds `cache_control` marks in Chat Completions. edupi sends every model the same Chat Completions body.
- **No long cache retention.** pi's `cacheRetention: "long"` (or `PI_CACHE_RETENTION=long`) adds `prompt_cache_key` and `prompt_cache_retention: "24h"`; edupi only knows `"none"` (no session header) and treats `"long"` as the default `"short"`.
- **No `User-Agent` header and no request timeout.** pi sends `User-Agent: pi (<os> <release>; <arch>)` and supports `timeoutMs`; edupi sends the SDK's defaults.
- **No early key check in `streamSimple`.** pi's `streamSimple` throws at once without an API key; edupi's `stream()` turns it into an `error` event. `AgentSession.prompt` checks the key before a run in both.
- **Error text from the OpenAI SDK only.** pi's `normalizeProviderError` also reads the error shapes of the Mistral, Google and Bedrock SDKs.
- **The faux provider fakes HTTP**, not the API (see above), and has no deferred responses or factory steps.

## Try it

Run edupi with the faux provider, log its requests, and send two prompts:

```bash
node bin/edupi.mjs --mode rpc --faux examples/faux/demo.json --faux-log /tmp/edupi-requests.jsonl
{"type":"prompt","message":"First question?"}
{"type":"prompt","message":"Second question?"}
```

Press Ctrl-D, then read `/tmp/edupi-requests.jsonl`. The second body repeats the first question and answer.

In the visualiser, pick **edupi** (or **edupi-faux**) and send a message. In the **Protocol** tab, filter for `text_delta` to see the reply arrive piece by piece. Filter for `streamEvent` to see the raw chunks each delta came from.

Send a second message and open the **Requests** tab. It lists the request as Chat Completions messages (role and text). Open an educodex viewer next to it and send the same messages: its Requests tab lists Responses input items, with the instructions as developer messages.

## Further reading

- [OpenRouter quickstart](https://openrouter.ai/docs/quickstart) and [API reference](https://openrouter.ai/docs/api-reference/overview): the OpenAI-compatible endpoint and OpenRouter's extra fields.
- [OpenAI: Chat Completions API](https://platform.openai.com/docs/api-reference/chat) and [Migrate to the Responses API](https://platform.openai.com/docs/guides/migrate-to-responses): the two APIs side by side.
- pi's thinking level map from OpenRouter's reasoning metadata: [`getOpenRouterThinkingLevelMap`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/scripts/openrouter-reasoning-options.ts#L12) and [`getEffortThinkingLevelMap`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/scripts/models-dev-reasoning-options.ts#L18).
- pi's own docs at the pinned commit: [`packages/ai/README.md`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/README.md).
