# 02 — Talking to a model

## Concept

### One HTTP request, one reply

A harness talks to the model through an HTTP API. educodex and Codex both use the **Responses API**: you `POST` a JSON body to `/responses`, and the model answers with a list of **output items**.

The smallest useful request looks like this:

```json
{
  "model": "openai/gpt-6-luna",
  "input": [
    {"type": "message", "role": "user",
     "content": [{"type": "input_text", "text": "What is 2+2?"}]}
  ]
}
```

And the reply contains:

```json
"output": [
  {"type": "message", "role": "assistant", "phase": "final_answer",
   "content": [{"type": "output_text", "text": "4"}]}
]
```

### Items, not chat messages

Everything in a conversation is an **item** with a `type`. A plain chat message is one kind of item. A coding agent sees more:

| Item type | Who makes it | What it is |
|---|---|---|
| `message` | harness or model | Text with a `role` |
| `reasoning` | model | The model's hidden thinking, sent back encrypted (chapter 08) |
| `function_call` / `custom_tool_call` | model | "Please run this tool" (chapter 03) |
| `function_call_output` / `custom_tool_call_output` | harness | The tool's result |

The conversation history is just a list of these items. The harness keeps that list and decides what goes into the next request.

### Roles

Each `message` has a `role`. The [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/) post lists them in decreasing priority:

| Role | Written by | Used for |
|---|---|---|
| `system` | the API provider | Rules you cannot see or change |
| `developer` | the harness | The harness's own rules: base prompt, sandbox rules |
| `user` | the human (and the harness on their behalf) | The task, plus facts like the working directory |
| `assistant` | the model | Its answers |

Models are trained to give `developer` text more weight than `user` text. That's why a harness puts its rules in `developer` messages. Chapter 05 shows which piece goes where.

### Tokens and the context window

Models read **tokens**, not characters. A token is a common chunk of text; for English and code, one token is about 4 bytes. Harnesses use that rule of thumb when they need a quick estimate.

Every model has a **context window**: the most tokens one request can hold, input and output together. For `gpt-6-luna` it is 272,000 tokens (`context_window` in `models.json`). The reply tells you the real count:

```json
"usage": {"input_tokens": 446, "input_tokens_details": {"cached_tokens": 0},
          "output_tokens": 13, "output_tokens_details": {"reasoning_tokens": 0},
          "total_tokens": 459}
```

(Real numbers from `spikes/out/roundtrip_2.json`.) `cached_tokens` matters in chapter 05. Running out of window matters in chapter 15.

### Streaming: Server-Sent Events

A reply can take a minute. Instead of waiting, the harness asks for `"stream": true`. The server then sends **Server-Sent Events (SSE)**: lines of text, each starting with `data:`, with one JSON event per line:

```
data: {"type":"response.created", ...}
data: {"type":"response.output_item.added", "item":{"type":"message", ...}}
data: {"type":"response.output_text.delta", "delta":"for"}
data: {"type":"response.output_text.delta", "delta":"ty-two"}
data: {"type":"response.output_item.done", "item":{...the full item...}}
data: {"type":"response.completed", "response":{"usage":{...}}}
```

The harness uses two kinds of events:
- **Deltas** (`response.output_text.delta`, `response.reasoning_summary_text.delta`) show text in the UI while it is being written.
- **`response.output_item.done`** carries the finished item. *This* is what goes into history.

`response.completed` ends the stream and carries `usage`. `response.failed` or `error` means something broke.

### Stateless requests: send everything, every time

The model has no memory between requests. Each request must carry the **whole** conversation: instructions, every earlier message, every tool call and its output.

The Responses API *can* remember for you (`store: true` plus `previous_response_id`). Codex doesn't use that on its HTTP path:
- `store: false`: the server keeps nothing.
- No `previous_response_id`: every request is complete on its own.

The Unrolling post gives the reasons: requests stay stateless, and it supports Zero Data Retention customers. The cost is that the JSON sent grows with every step (quadratic over a conversation). Prompt caching (chapter 05) makes that cheap again.

```
request 1:  [instructions, user]
request 2:  [instructions, user, reasoning, function_call, function_call_output]
request 3:  [instructions, user, reasoning, function_call, function_call_output, assistant, user]
            └──────────── always an exact prefix of the next one ─────────────┘
```

## In educodex

[`client.py`](../../src/educodex/core/client.py) builds the body. This is the whole function:

```python
def build_request(self, prompt: Prompt) -> dict[str, Any]:
    reasoning: dict[str, Any] = {"effort": self.reasoning_effort}
    if self.info.supports_reasoning_summary_parameter and self.reasoning_summary != "none":
        reasoning["summary"] = self.reasoning_summary
    body: dict[str, Any] = {
        "model": self.model,
        "input": [developer_message(prompt.base_instructions), *prompt.input],
        "tools": prompt.tools,
        "tool_choice": "auto",
        "parallel_tool_calls": prompt.parallel_tool_calls,
        "reasoning": reasoning,
        "store": False,
        "stream": True,
        "include": ["reasoning.encrypted_content"],
        "prompt_cache_key": self.session_id,
    }
    if self.info.support_verbosity and self.info.default_verbosity:
        body["text"] = {"verbosity": self.info.default_verbosity}
    return body
```

Things to notice:
- There is no `instructions` field. The base prompt is `input[0]`, a `developer` message.
- `input` is the whole history, from `session.history.for_prompt()` ([`history.py`](../../src/educodex/core/history.py)).
- `include: ["reasoning.encrypted_content"]` asks for reasoning we can send back, since nothing is stored server-side.
- `prompt_cache_key` is the thread id, so all requests of one thread hit the same cache.

`_parse_sse` in the same file reads `data:` lines and turns them into `ResponseEvent`s. Like Codex, it decides how a stream may end:
- `response.completed` ends it normally.
- `response.incomplete` with reason `interrupted` also ends it normally. Any other reason (for example `max_output_tokens`) is an error.
- `response.failed` and `error` raise an error.
- A stream that closes before `response.completed` is an error too, so a half-received reply is never taken as complete.

If `response.completed` carries `end_turn: false`, the server is asking the harness to keep going. The loop then calls the model again even without tool calls (chapter 04).

Items are plain dicts in wire format ([`items.py`](../../src/educodex/core/items.py)), so history shows exactly what the model receives. `clean_output_item` drops API-only fields like `status` before an item is stored.

[`turn.py`](../../src/educodex/core/turn.py) `run_sampling_request` consumes the stream. Deltas become UI events. `output_item.done` items get recorded:

```python
elif event.type == "response.output_item.done":
    item = clean_output_item(data["item"])
    await session.record(item)
```

## In Codex

- [`build_responses_request`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/client.rs#L891) in `core/src/client.rs` builds the same body. The base instructions are spliced in as the first item [here](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/client.rs#L931). The struct is filled [here](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/client.rs#L996), with `store: false` and `stream: true`.
- [`BaseInstructionsFragment`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/context/base_instructions.rs#L31) has role `developer` and no wrapper tags.
- [`build_reasoning`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/client.rs#L869) sends `summary` only if the model supports it and it isn't `none`. educodex copies this rule.
- [`ResponsesApiRequest`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/codex-api/src/common.rs#L279) in `codex-api/src/common.rs` is the wire struct. It has no `instructions` and no `previous_response_id` field. A comment explains why `model` and `stream` come first: gateways may read the start of a multi-megabyte body before the rest arrives.
- [`process_responses_event`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/codex-api/src/sse/responses.rs#L344) in `codex-api/src/sse/responses.rs` maps SSE events to [`ResponseEvent`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/codex-api/src/common.rs#L81). `response.incomplete` with reason `interrupted` is treated like `response.completed` ([here](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/codex-api/src/sse/responses.rs#L418)); other reasons are errors.
- [`ResponseItem`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/models.rs#L1014) in `protocol/src/models.rs` lists every item type.
- [`Prompt`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/client_common.rs#L23) in `core/src/client_common.rs` is what one request needs: input, tools, base instructions.

Note: the Unrolling post (January 2026) says Codex sends base instructions in the `instructions` field. At the pinned commit it sends them as the first `developer` item instead. Codex changes quickly.

## Where educodex is simpler

- **HTTP only.** Codex prefers a WebSocket transport. There it *does* use `previous_response_id` to send only new items, and it "prewarms" the connection ([`client.rs` header](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/client.rs#L17)). The stateless HTTP path is the one that teaches the idea.
- **No "Responses Lite".** Most models in the catalog (including `gpt-6-luna`) have `use_responses_lite: true`. For those, Codex sends tools as an `additional_tools` item inside `input` instead of the top-level `tools` field, and sets `parallel_tool_calls: false` ([source](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/client.rs#L915)). educodex always uses the classic layout, as Codex does for `gpt-5.5`. Chapter 06 explains this.
- **Fewer fields.** No `service_tier`, `stream_options` or `client_metadata`.
- **Reasoning summaries on.** Codex uses the model's `default_reasoning_summary` (`none` for current models). educodex asks for `auto` so you can read them.
- **Simple retries.** Up to 3 attempts, and only before the first event arrives.

## Try it

Run one turn and watch the request summary line (`input items=… tools=… store=False`):

```bash
uv run educodex exec "What is 2+2? Answer with one word."
```

Add `-v` to print the full request body as JSON:

```bash
uv run educodex exec -v "What is 2+2? Answer with one word."
```

Check that `input[0]` is the 18k-character base prompt with role `developer`.

In the web UI, run `uv run educodex app-server` and open http://127.0.0.1:8765. Send a message, then open the **Requests** tab. It shows each request body and the response (output items, usage, event counts). With two or more requests, it also tells you whether earlier items stayed unchanged.

Offline, add `--fake-model examples/fake/demo.json` to `exec` or `app-server` (no API key needed). To see what a raw SSE stream looks like, print the events the fake model sends:

```bash
uv run python -c "import json; from educodex.testing.fake_model import sse_events; [print('data:', json.dumps(e)) for e in sse_events([{'type': 'message', 'text': 'forty-two!'}])]"
```

## Further reading
- [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/): roles, SSE events and why Codex avoids `previous_response_id`.
- [OpenRouter Responses API](https://openrouter.ai/docs/api_reference/responses/overview): the endpoint educodex uses.
- [Streaming API responses](https://platform.openai.com/docs/guides/streaming-responses) and [Conversation state](https://platform.openai.com/docs/guides/conversation-state): OpenAI's guides to streaming and to `store` / `previous_response_id`.
- [Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events): MDN's intro to the SSE format.
