# 06 — The model catalog

## Concept

### One harness, many models

A harness talks to more than one model. Each model was trained a little differently, so each one works best with slightly different settings:
- a system prompt written for *that* model,
- an edit tool in the shape it was trained on,
- its own context window size,
- sensible defaults for how hard it thinks and how much it writes.

You could hard-code these with `if model == ...` branches. Codex puts them in data instead: a **model catalog**, one JSON object per model. The harness reads the entry for the chosen model and adjusts itself.

```
            models.json
   ┌───────────────────────────┐
   │ gpt-6-luna   { ... }      │──┐
   │ gpt-6-sol    { ... }      │  │  look up by slug
   │ gpt-5.5      { ... }      │  │
   └───────────────────────────┘  ▼
                         ModelInfo ──► prompt (instructions_template)
                                   ──► tools (apply_patch, shell)
                                   ──► limits (context window, truncation)
                                   ──► request (reasoning effort, verbosity)
```

So the harness changes what it does based on the model. Codex can change that behaviour by shipping a new catalog, without a new release of the code.

### One entry, trimmed

This is part of the `gpt-6-luna` entry (the real one has ~50 fields and an 18,000-character prompt):

```json
{
  "slug": "gpt-6-luna",
  "display_name": "GPT-6-Luna",
  "context_window": 272000,
  "auto_compact_token_limit": null,
  "truncation_policy": { "mode": "tokens", "limit": 10000 },
  "apply_patch_tool_type": "freeform",
  "shell_type": "shell_command",
  "supports_parallel_tool_calls": true,
  "tool_mode": "code_mode_only",
  "use_responses_lite": true,
  "default_reasoning_level": "medium",
  "default_reasoning_summary": "none",
  "supports_reasoning_summary_parameter": true,
  "support_verbosity": true,
  "default_verbosity": "low",
  "model_messages": {
    "instructions_template": "You are Codex, an agent based on GPT-6. You and the user share one workspace, ..."
  }
}
```

### What each field controls

| Field | What the harness does with it | Chapter |
|---|---|---|
| `model_messages.instructions_template` | The base instructions. Sent as the first `developer` message. The name is old; today it is plain text, not a template | 05 |
| `apply_patch_tool_type` | `"freeform"` means: offer `apply_patch` as a custom tool with a grammar. Missing means: no `apply_patch` tool | 03, 07 |
| `shell_type` | Which shell tool to offer. `"shell_command"` is an old name that now means `exec_command` / `write_stdin`; `"disabled"` means no shell | 07 |
| `truncation_policy` | The most tool output (here 10,000 tokens) that goes back to the model. Longer output is cut in the middle | 07 |
| `context_window` | How many tokens the model can see at once | 14 |
| `auto_compact_token_limit` | When to start compaction. The harness uses `min(limit, 90% of context_window)`. `null` means just 90% | 14 |
| `default_reasoning_level` | The `reasoning.effort` to send when the user did not pick one | 08 |
| `default_reasoning_summary`, `supports_reasoning_summary_parameter` | Whether to ask for reasoning summaries, and whether the model accepts that parameter at all | 08 |
| `support_verbosity`, `default_verbosity` | `text.verbosity`: how long the model's answers should be (`low` / `medium` / `high`) | 02 |
| `supports_parallel_tool_calls` | The `parallel_tool_calls` flag in the request | 04 |
| `tool_mode` | How tools reach the model: classic tool calls, or "code mode" (see below) | 03, 07 |
| `use_responses_lite` | Send the tool list as an input item instead of the top-level `tools` field (see below) | 02 |

The compaction limit, worked out for `gpt-6-luna`:

```
context_window           = 272,000
90% of it                = 244,800
auto_compact_token_limit = null      → limit = 244,800 tokens
```

If a model had `auto_compact_token_limit: 300000`, the limit would still be 244,800: the 90% cap wins.

### Two fields educodex records but does not follow

Two fields change the request shape a lot, so it is worth knowing what they do even though educodex does not copy them.

**`tool_mode: "code_mode_only"` (code mode).** With classic tools, the model sees a list of tools (`exec_command`, `apply_patch`, …) and calls one per tool call. In code mode, Codex shows the model a single freeform tool named `exec` (plus a small `wait` tool). The model writes a short **JavaScript** program, and that program calls the real tools as functions. One model call can then run a whole sequence (read a file, filter it, write a patch) without a round trip per step. `code_mode_only` means the other tools are reachable *only* from inside that JavaScript. Other values: `code_mode` (both ways) and `direct` (classic).

**`use_responses_lite: true` (Responses Lite).** The tool list moves out of the top-level `tools` field and into the conversation, as an `additional_tools` item at the start of `input`, and `parallel_tool_calls` is sent as `false`.

In today's catalog every listed model except `gpt-5.5` has both: `tool_mode: "code_mode_only"` and `use_responses_lite: true`. So **Codex talks to `gpt-6-luna` through one JavaScript `exec` tool, with the tool list inside `input`.** For `gpt-5.5` (`tool_mode: null`, `use_responses_lite: false`) it uses classic tool calling.

educodex uses classic tool calling for every model, the way Codex calls `gpt-5.5`. Classic tools show each step as its own tool call, which is easier to learn from. The cost is that educodex does not send `gpt-6-luna` exactly what Codex sends. To keep this visible, educodex stores both values (`codex_tool_mode`, `codex_use_responses_lite`) and prints a note when it registers tools. Chapter 18 has pointers into Codex's code-mode implementation.

### Why per-model settings matter

Look at the current catalog (11 models) and you see the differences are real:
- **Prompts differ.** `gpt-6-luna`, `gpt-6-sol` and `gpt-6-astra` each have their own prompt (18k to 21k characters). The `gpt-5.6-*` models share an older one. A prompt tuned for one model can make another one worse.
- **Limits differ.** `gpt-daybreak-red-latest` has a 372,000-token window; the others have 272,000.
- **Defaults differ.** `gpt-6-astra` defaults to `low` effort, `gpt-6-luna` to `medium`. `gpt-daybreak-red-latest` defaults to `high` verbosity.
- **Tool shapes follow training.** A model trained to write patches in a grammar should get the grammar tool. That is what `apply_patch_tool_type` encodes.

## In educodex

[`models.py`](../../src/educodex/core/models.py) reads the vendored catalog and keeps only the fields educodex uses:

```python
@dataclass(frozen=True)
class ModelInfo:
    slug: str
    base_instructions: str          # model_messages.instructions_template
    context_window: int
    auto_compact_token_limit: int | None
    truncation_limit_tokens: int    # truncation_policy.limit
    apply_patch_tool_type: str | None   # None -> no apply_patch tool
    ...
    # How Codex itself would call this model; educodex only reports these.
    codex_tool_mode: str | None         # "code_mode_only" -> Codex exposes one JavaScript `exec` tool
    codex_use_responses_lite: bool      # Codex sends tools as an `additional_tools` input item

    def effective_auto_compact_limit(self) -> int:
        """Codex compacts at min(configured limit, 90% of the context window)."""
        ninety_percent = self.context_window * 9 // 10
        if self.auto_compact_token_limit is None:
            return ninety_percent
        return min(self.auto_compact_token_limit, ninety_percent)
```

`model_info("openai/gpt-6-luna")` drops the OpenRouter prefix (`openai/`) and looks up `gpt-6-luna`. If there is no exact match, it falls back, like Codex, to the longest catalog slug that is a prefix of the name: `gpt-6-luna-2026-10` finds `gpt-6-luna`. A name with no match at all raises `KeyError`. Missing fields get Codex's defaults; for example `supports_reasoning_summary_parameter` defaults to `true`.

Where the fields are used:

| Field | Used in |
|---|---|
| `base_instructions` | [`session.py`](../../src/educodex/core/session.py) picks it (unless `config.base_instructions` overrides it); [`client.py`](../../src/educodex/core/client.py) puts it at `input[0]` |
| `default_reasoning_level`, `supports_reasoning_summary_parameter`, `support_verbosity`, `default_verbosity` | `ModelClient.build_request` in [`client.py`](../../src/educodex/core/client.py) |
| `supports_parallel_tool_calls` | the `Prompt` built in [`turn.py`](../../src/educodex/core/turn.py) |
| `truncation_limit_tokens` | `_max_tokens` in [`tools/handlers.py`](../../src/educodex/core/tools/handlers.py) and MCP output in [`mcp/manager.py`](../../src/educodex/core/mcp/manager.py) |
| `effective_auto_compact_limit()` | the compaction checks in [`turn.py`](../../src/educodex/core/turn.py) |
| `apply_patch_tool_type` | `builtin_handlers` in [`tools/handlers.py`](../../src/educodex/core/tools/handlers.py): no `apply_patch` tool when it is missing |
| `codex_tool_mode`, `codex_use_responses_lite` | only reported: [`session.py`](../../src/educodex/core/session.py) adds `codexToolModeNote` to the `trace/toolsRegistered` event |

The catalog file itself is a copy. [`scripts/sync_vendor.py`](../../scripts/sync_vendor.py) copies `codex-rs/models-manager/models.json` (and the prompts, grammar and sandbox files) into [`vendor/codex/`](../../src/educodex/vendor/codex/) and writes `SOURCE.md` with the Codex commit. To update, run the script and read the diff: it shows exactly what OpenAI changed in prompts and settings.

## In Codex

| What | Where |
|---|---|
| The catalog, compiled into the binary | [`models-manager/src/lib.rs#L13`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/models-manager/src/lib.rs#L13) (`include_str!("../models.json")`) |
| The `gpt-6-luna` entry | [`models-manager/models.json#L524`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/models-manager/models.json#L524) |
| `ModelInfo`, every field typed | [`protocol/src/openai_models.rs#L406`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/openai_models.rs#L406) |
| `shell_command` is an alias of `UnifiedExec` | [`openai_models.rs#L316`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/openai_models.rs#L316) |
| `ApplyPatchToolType` (only `Freeform`) | [`openai_models.rs#L324`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/openai_models.rs#L324) |
| `auto_compact_token_limit()`: `min(limit, 90%)` | [`openai_models.rs#L527`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/openai_models.rs#L527) |
| `instructions_template` "formerly a personality template" | [`openai_models.rs#L543`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/openai_models.rs#L543) |
| Fetching `/models`, 5-minute cache in `models_cache.json` | [`models-manager/src/manager.rs#L34`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/models-manager/src/manager.rs#L34) |
| Slug lookup: longest prefix, then `namespace/model` | [`manager.rs#L865`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/models-manager/src/manager.rs#L865) |
| Fallback metadata for unknown models | [`models-manager/src/model_info.rs#L98`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/models-manager/src/model_info.rs#L98) |
| User config overrides (context window, compaction limit, tool output limit, base instructions) | [`model_info.rs#L19`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/models-manager/src/model_info.rs#L19) |
| Tools chosen from the catalog: shell | [`core/src/tools/spec_plan.rs#L1159`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/spec_plan.rs#L1159) |
| Tools chosen from the catalog: `apply_patch` | [`spec_plan.rs#L1344`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/spec_plan.rs#L1344) |
| `tool_mode` and `use_responses_lite` fields | [`openai_models.rs#L485`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/openai_models.rs#L485), [`#L503`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/openai_models.rs#L503) |
| Code mode: the `exec` tool and its JavaScript grammar | [`core/src/tools/code_mode/execute_spec.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/code_mode/execute_spec.rs#L5), registered in [`spec_plan.rs#L863`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/spec_plan.rs#L863) |
| Responses Lite: tools as an `additional_tools` input item | [`core/src/client.rs#L915`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/client.rs#L915), and [`parallel_tool_calls` off](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/client.rs#L1001) |
| Effort, summary and verbosity in the request | [`core/src/client.rs#L869`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/client.rs#L869) and [`#L962`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/client.rs#L962) |

Codex starts with the bundled catalog, then asks the backend's `/models` endpoint for a fresh one and caches it on disk. That way OpenAI can change a prompt or a limit for everyone without shipping a new binary.

## Where educodex is simpler

- **No remote catalog.** educodex only reads the vendored file. There is no `/models` fetch, cache or ETag refresh.
- **No generic fallback.** Like Codex, educodex matches by longest prefix. But for a name with no match, Codex falls back to generic metadata; educodex raises an error.
- **Classic tools for every model.** educodex records `tool_mode` and `use_responses_lite` but does not follow them (see above), so it sends `gpt-6-luna` a classic `tools` list where Codex would use code mode and Responses Lite.
- **Fewer fields.** We ignore `effective_context_window_percent`, `max_context_window`, service tiers, multi-agent settings and most other `model_messages` sections (approvals, ...).
- **Fewer user overrides.** Codex lets config override the context window, compaction limit and tool output limit. educodex only lets you override the base instructions and reasoning effort.
- **`shell_type` is ignored.** educodex always offers `exec_command` and `write_stdin`. It does follow `apply_patch_tool_type` (no `apply_patch` when it is missing). Every model in today's catalog gets both tools anyway.

## Try it

Look up a model from Python:

```bash
uv run python -c "
from educodex.core.models import model_info
m = model_info('openai/gpt-6-luna')
print(m.context_window, m.effective_auto_compact_limit(), m.truncation_limit_tokens, m.default_reasoning_level)
print(m.codex_tool_mode, m.codex_use_responses_lite, model_info('gpt-6-luna-2026-10').slug)
print(m.base_instructions[:300])"
```

Expected: `272000 244800 10000 medium`, then `code_mode_only True gpt-6-luna-2026-10` (the dated name was found by prefix), then the start of the Codex prompt.

Compare two models' prompts and defaults:

```bash
uv run educodex exec -v --model openai/gpt-6-sol "Say hi"
uv run educodex exec -v --model openai/gpt-6-luna "Say hi"
```

The `tools` line is followed by a `note:` that says how Codex would call this model (code mode and Responses Lite for `gpt-6-luna` and `gpt-6-sol`). The "prompt assembly" block shows the base instructions' size and source, and the `loop` line shows `compact at 244800`. With `-v` you also get the request body: `input[0]` (the base instructions) and `reasoning.effort` change with the model (`gpt-6-sol` and `gpt-6-luna` both default to `medium`; try `openai/gpt-6-astra` for `low`).

In the web UI (`uv run educodex app-server`, then open http://127.0.0.1:8765):
- **Context** tab: the first item is the base instructions, labelled with its source (`vendor/codex/models.json → gpt-6-luna.model_messages.instructions_template`), and the bar shows usage against the context window.
- **Requests** tab: the full body, with `reasoning`, `text.verbosity` and `parallel_tool_calls` taken from the catalog.
- **Timeline** tab: `trace/loopIteration` shows `autoCompactLimit` (244,800 for `gpt-6-luna`), and `trace/toolsRegistered` carries `codexToolModeNote`.

Offline, no API key needed: add `--fake-model examples/fake/demo.json` to `exec` or `app-server`.

See what changed upstream after a sync:

```bash
uv run scripts/sync_vendor.py ../codex && git diff --stat src/educodex/vendor/codex/
```

## Further reading
- [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/): where the base instructions sit in the prompt.
- [Configuration reference](https://developers.openai.com/codex/config-reference): the user-side settings (`model_context_window`, `model_auto_compact_token_limit`, `model_reasoning_effort`, ...) that override catalog values.
- [Edit formats](https://aider.chat/docs/more/edit-formats.html): why the best edit tool depends on the model.
- [Harness engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/).
