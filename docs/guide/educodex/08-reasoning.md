# 08 — Reasoning

## Concept

### Models that think before they answer

Reasoning models (all models in the Codex catalog) produce hidden "thinking" tokens before their visible answer. They plan, check and change their mind. You pay for these tokens, and they take time, but they make answers on hard tasks much better.

The Responses API returns this thinking as its own item type, `reasoning`, placed before the message or tool call it led to:

```
output: [ reasoning ] [ message "Yes, because ..." ]
output: [ reasoning ] [ function_call exec_command ] [ function_call exec_command ]
```

### What a reasoning item contains

This is from `spikes/out/reasoning.json` (the prompt was "Is 2^61-1 prime? Answer yes or no, then one sentence why."), shortened:

```json
{
  "id": "rs_09f456d05f6ae8a8016ac6b6a11f8487d1a99360a8f3565710",
  "type": "reasoning",
  "summary": [
    {"type": "summary_text",
     "text": "**Clarifying Mersenne primes**\n\nI need to provide a factual answer about the Mersenne prime exponent 61. ..."}
  ],
  "encrypted_content": "gAAAAABqxrai__D0TGtoaXxY1FDXpoHG...(1,684 chars)",
  "format": "openai-responses-v1"
}
```

Two different things are here:

| Field | What it is | Who can read it |
|---|---|---|
| `summary` | A short, human-readable summary of the thinking, written by the model | You and the user |
| `encrypted_content` | The real reasoning, encrypted by OpenAI | Only OpenAI's servers |

The raw chain of thought is never shown. You get a summary for the UI and an opaque blob for the next request.

The usage block shows the cost: `"output_tokens": 73` of which `"reasoning_tokens": 45`. More than half the output was thinking.

### Three knobs in the request

```json
"reasoning": {"effort": "medium", "summary": "auto"},
"include": ["reasoning.encrypted_content"]
```

- **`effort`**: how hard to think. Values in the catalog are `low`, `medium`, `high`, `xhigh`, `max`. Higher effort means more reasoning tokens, so slower and more expensive, and usually better on hard problems. Each model has a default (`gpt-6-luna`: `medium`).
- **`summary`**: whether to return summaries: `auto`, `concise`, `detailed`, or leave it out. With `auto` the server picks; the spike asked for `auto` and the response echoed `"summary": "detailed"`. Even then the model may return an empty `summary: []` for a short thought.
- **`include: ["reasoning.encrypted_content"]`**: please put the encrypted reasoning in the response.

### Why the harness must send reasoning back

Chapter 02 showed that Codex sends `store: false`. OpenAI keeps nothing between requests, and the harness resends the full history every time. That includes the model's own earlier reasoning.

Think of an agent mid-task:

```
request 1:  [user: fix the test]
response 1: [reasoning: "the bug is in parse(); first I'll read utils.py"] [exec_command cat utils.py]
request 2:  [user] [reasoning ???] [exec_command] [exec_command output]
```

If request 2 drops the reasoning item, the model sees its own tool call but not *why* it made it. It has to work out its plan again, which costs tokens and may lead it somewhere else. So the harness keeps the reasoning item and sends it back. Because the server stored nothing, it can only rebuild the reasoning from `encrypted_content`. That is why Codex always asks for it in `include`.

```
            store: true                          store: false (Codex)
 server keeps reasoning by id         harness keeps {encrypted_content}
 client sends previous_response_id    client resends the whole item
 server state needed                  no server state; works with zero data retention
```

The spike checked this works on OpenRouter: sending `reasoning.json`'s output back with a follow-up question returned HTTP 200.

Reasoning items also take space in the context window. Codex estimates their size from the length of `encrypted_content`, since it cannot read the text.

### Why educodex asks for summaries but Codex does not

Every model in the catalog has `"default_reasoning_summary": "none"`. Codex uses the model default unless you set `model_reasoning_summary` in config. With `none`, Codex leaves `summary` out of the request, so no summaries come back. Summaries are extra output the user may never read.

educodex is a teaching tool, and watching the model's thinking is the point. So [`config.py`](../../../backends/educodex/src/educodex/core/config.py) defaults `reasoning_summary` to `"auto"`. This changes what you see, not how the agent works: the encrypted reasoning is returned and sent back either way.

## In educodex

The request, in [`client.py`](../../../backends/educodex/src/educodex/core/client.py):

```python
self.reasoning_effort = reasoning_effort or model_info.default_reasoning_level or "medium"
...
reasoning: dict[str, Any] = {"effort": self.reasoning_effort}
if self.info.supports_reasoning_summary_parameter and self.reasoning_summary != "none":
    reasoning["summary"] = self.reasoning_summary
body = {
    ...
    "reasoning": reasoning,
    "store": False,
    "include": ["reasoning.encrypted_content"],
}
```

The response, in [`turn.py`](../../../backends/educodex/src/educodex/core/turn.py):
- `response.output_item.added` with a reasoning item → `item/started` (`type: "reasoning"`) to the UI.
- `response.reasoning_summary_text.delta` → `item/reasoning/summaryTextDelta`, so the summary appears word by word.
- `response.output_item.done` → the item is cleaned (`clean_output_item` drops `status`) and **recorded in history unchanged**, `encrypted_content` included. Then `item/completed` sends just the summary texts to the UI.

`summary` is only sent when the catalog entry allows it (`supports_reasoning_summary_parameter`, `true` when the field is missing, as in Codex) and the setting is not `none`.

There is no special code for sending reasoning back. It sits in `session.history.items` like any other item, and the next `history.for_prompt()` includes it. `tests/test_turn.py` checks this: `assert third[4]["encrypted_content"]  # reasoning is sent back as-is`.

The effort can be set per thread or per turn (`--effort low|medium|high` on the CLI, `effort` in `thread/start` / `turn/start`). [`items.py`](../../../backends/educodex/src/educodex/core/items.py) lists the reasoning item shape next to the others.

## In Codex

| What | Where |
|---|---|
| `ResponseItem::Reasoning` (`summary`, `content`, `encrypted_content`) | [`protocol/src/models.rs#L1050`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/models.rs#L1050) |
| `ReasoningSummary`: `auto`, `concise`, `detailed`, `none` | [`protocol/src/config_types.rs#L65`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/config_types.rs#L65) |
| `ReasoningEffort` values | [`protocol/src/openai_models.rs#L60`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/openai_models.rs#L60) |
| Summary = config value, else model default | [`core/src/session/step_settings.rs#L63`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/step_settings.rs#L63) |
| `build_reasoning`: effort default, summary only if not `none` | [`core/src/client.rs#L869`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/client.rs#L869) |
| `include: ["reasoning.encrypted_content"]`, `store: false` | [`client.rs#L961`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/client.rs#L961) and [`#L1003`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/client.rs#L1003) |
| `reasoning.context` (`current_turn` / `all_turns`) | [`codex-api/src/common.rs#L151`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/codex-api/src/common.rs#L151) |
| SSE: summary deltas | [`codex-api/src/sse/responses.rs#L377`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/codex-api/src/sse/responses.rs#L377) |
| Estimating reasoning size from the encrypted length | [`core/src/context_manager/history.rs#L1053`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/context_manager/history.rs#L1053) |
| Counting earlier turns' reasoning in token usage | [`history.rs#L893`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/context_manager/history.rs#L893) |
| App-server notification `item/reasoning/summaryTextDelta` | [`app-server-protocol/src/protocol/common.rs#L2011`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/protocol/common.rs#L2011) |

## Where educodex is simpler

- **No `reasoning.context`.** Codex sends `context: "all_turns"` for models with `use_responses_lite`, so the server keeps reasoning from earlier turns visible. educodex omits it and takes the server default.
- **No raw reasoning content.** Codex also handles `content` (`reasoning_text`) and `response.reasoning_text.delta` for models that expose raw reasoning. educodex only shows summaries.
- **Rough token counting.** Codex estimates reasoning size from the encrypted length (about 3/4 of its length, minus 650) and treats earlier turns' reasoning specially. educodex counts the whole item's JSON at about 4 bytes per token.
- **No effort updates mid-history.** Codex can change effort with `configuration_update` items for models that support it. educodex just sends a new `effort` on the next request.
- **Summaries on by default** (`auto` instead of the model's `none`), as explained above.

## Try it

```bash
uv run educodex exec --effort high "Is 2^89-1 prime? One sentence why."
```

The dim `reasoning:` line is the summary. Run it again with `--effort low` and compare. The token counts per request (`output_tokens_details.reasoning_tokens`) are in the session log as `token_count` events (chapter 16), and in the web UI's `trace/modelResponse` events.

Look at the raw spike output:

```bash
python3 -m json.tool spikes/out/reasoning.json | less
```

Find `encrypted_content`, `summary`, and in `usage` the `output_tokens_details.reasoning_tokens`. To rerun the spike: `uv run --with httpx spikes/probe_openrouter.py`.

In the web UI ([start the launcher](README.md#the-web-ui) and pick **educodex**):
- **Chat**: reasoning summaries stream in before the answer.
- **Context** tab: the reasoning items sit in history between the user message and the tool calls. They are part of the next request.
- **Timeline** tab: `trace/modelResponse` has the `usage`, including `reasoning_tokens`.
- **Requests** tab: open the second request of a turn and find the reasoning item from the first response inside `input`, `encrypted_content` and all.
- **Protocol** tab: the `item/reasoning/summaryTextDelta` notifications.

Offline: add `--fake-model examples/fake/demo.json` to `exec`, or pick **educodex-demo** in the web UI. The script replays reasoning items with a fake `encrypted_content`, and `exec` prints their summaries as dim `reasoning:` lines.

Run the round-trip test:

```bash
uv run --group dev pytest tests/test_turn.py -v
```

## Further reading
- [Reasoning models](https://developers.openai.com/api/docs/guides/reasoning): effort, summaries, encrypted reasoning for stateless use.
- [Better performance from reasoning models using the Responses API](https://cookbook.openai.com/examples/responses_api/reasoning_items): why passing reasoning items back helps, with `store: false`.
- [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/): stateless requests and zero data retention.
- [OpenRouter Responses API](https://openrouter.ai/docs/api_reference/responses/overview).
