# 05 — Assembling the prompt

## Concept

### The model sees more than your message

When you type "fix the test", the model receives a lot more. The harness wraps your words in context the model needs:
- **who it is and how to work**: the base instructions, about 18,000 characters for `gpt-6-luna`;
- **what it may do**: sandbox and approval rules;
- **what the project wants**: `AGENTS.md` files written by humans for agents;
- **where it is**: working directory, shell, date, timezone.

This step is **prompt assembly**. Here is the layout Codex sends on the first request of a thread. It comes from Codex's own test snapshot, `model_visible_layout_cwd_change_refreshes_agents`:

```
00: message/developer   <MODEL_INSTRUCTIONS>              ← base instructions
01: message/developer   [01] <SKILLS_INSTRUCTIONS>        ← one message, several parts
                        [02] <PERMISSIONS_INSTRUCTIONS>
02: message/user        [01] <AGENTS_MD>
                        [02] <ENVIRONMENT_CONTEXT>
03: message/user        first turn in agents_one          ← what you typed
```

educodex builds the same shape (without skills).

### Base instructions: the first developer message

The base prompt comes from the model catalog (`models.json` → `model_messages.instructions_template`, chapter 06). It goes in as `input[0]`, a `developer` message with no wrapper tags. The Responses API also has a separate `instructions` field, but Codex no longer uses it (chapter 02).

### Developer bundle vs user bundle

The other context pieces are **fragments**. Each one has a role:

| Fragment | Role | Wrapper | Why this role |
|---|---|---|---|
| `developer_instructions` (from config) | developer | none | The harness owner's rules |
| Memories (when on, chapter 17) | developer | starts with `## Memory` | What earlier threads learned |
| Skills catalog (chapter 14) | developer | `<skills_instructions>` … `</skills_instructions>` | Which skills exist and where |
| Permissions | developer | `<permissions instructions>` … `</permissions instructions>` | Rules the model must follow |
| Collaboration mode | developer | `<collaboration_mode>` … `</collaboration_mode>` | How to behave: Default or Plan mode |
| AGENTS.md | user | `# AGENTS.md instructions for <cwd>` … `<INSTRUCTIONS>` … `</INSTRUCTIONS>` | Written by the user's team |
| Environment | user | `<environment_context>` … `</environment_context>` | Facts about the user's machine |

The rule of thumb: **rules from the harness are `developer`; things from the user's world are `user`**. Developer messages carry more weight (chapter 02), so a line in a repo's `AGENTS.md` can't override the sandbox rules.

All developer fragments go into **one** developer message, each as its own `input_text` part. The same goes for the user fragments. In JSON:

```json
{"type": "message", "role": "user", "content": [
  {"type": "input_text", "text": "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nRun tests with `uv run pytest`.\n</INSTRUCTIONS>"},
  {"type": "input_text", "text": "<environment_context>\n  <cwd>/repo</cwd>\n  <shell>zsh</shell>\n  <current_date>2026-10-08</current_date>\n  <timezone>Europe/Berlin</timezone>\n  <filesystem>…</filesystem>\n</environment_context>"}
]}
```

**Why wrapper tags?** They help twice. The model can tell harness context apart from the user's own words. And the harness can find its own fragments in history later. Codex checks for known tags so it doesn't show them in the UI as messages you typed ([`parse_user_message`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/event_mapping.rs#L98)).

### Later turns: append what changed, never edit

Suppose you change the sandbox mode between turns. The permissions text is now wrong. The obvious fix is to edit item 01. **Codex never does that.** It appends a new message with the new fragment, and leaves the old one where it is. From Codex's `model_visible_layout_turn_overrides` snapshot, where turn 2 changes cwd and approval policy:

```
-- request 2 --
04: message/assistant   turn one complete
05: message/developer   <PERMISSIONS_INSTRUCTIONS>        ← new, appended
06: message/user        <ENVIRONMENT_CONTEXT>             ← new, appended
07: message/user        second turn with context updates
```

Fragments that didn't change are not sent again. The model reads the latest version as the one in force.

### Why: prompt caching

Every request resends the whole history (chapter 02). The provider makes that cheap with a **prompt cache**: if the start of your prompt matches a recent request exactly, the work for that part is reused. It's faster and costs less. The Unrolling post quotes OpenAI's caching docs:

> Cache hits are only possible for exact prefix matches within a prompt. To realize caching benefits, place static content like instructions and examples at the beginning of your prompt, and put variable content, such as user-specific information, at the end.

So the golden rule is: **only ever append.** Editing item 01 would change the prefix and lose the cache for everything after it. The post lists what causes a miss in Codex:
- changing the `tools` list mid-conversation (even its order: an early MCP bug listed tools in a random order);
- changing the model, because the base instructions change;
- changing sandbox, approval mode or cwd, which is why those changes are *appended*.

You can see the effect in `usage.input_tokens_details.cached_tokens`. Requests also send `prompt_cache_key` (the thread id) to help the provider route them to the same cache.

## In educodex

[`context/world_state.py`](../../../backends/educodex/src/educodex/core/context/world_state.py) builds the fragments in Codex's order:

```python
fragments.append(render_permissions(config.sandbox_mode, config.approval_policy, config.network_access, roots))
if mode := collaboration_mode_text(config.model):
    fragments.append(Fragment("collaboration_mode", "developer", f"<collaboration_mode>{mode}</collaboration_mode>", ...))
if agents := render_agents_md(config.cwd, config.home):
    fragments.append(agents)
fragments.append(render_environment_context(config.cwd, config.sandbox_mode, roots))
```

(`developer_instructions` comes first when set.) Each renderer lives in its own module:
- [`permissions.py`](../../../backends/educodex/src/educodex/core/context/permissions.py) joins Codex's vendored templates (`sandbox_mode/*.md` + `approval_policy/*.md`). Under `workspace-write` it ends with every root the sandbox lets the agent write, e.g. ``The writable roots are `/repo`, `/private/tmp`, `/private/var/folders/…/T`.`` (cwd, `/tmp` and `$TMPDIR`, the same list the Seatbelt policy uses, chapter 10).
- [`agents_md.py`](../../../backends/educodex/src/educodex/core/context/agents_md.py) finds `AGENTS.override.md` or `AGENTS.md` in the educodex home (`~/.eduagent/.educodex`) and in every folder from the git root down to cwd, up to 32 KiB in total.
- [`environment.py`](../../../backends/educodex/src/educodex/core/context/environment.py) writes `<environment_context>`.

`diff` and `to_messages` implement "append only what changed":

```python
def diff(previous: dict[str, str] | None, current: list[Fragment]) -> list[Fragment]:
    if previous is None:
        return current
    return [f for f in current if previous.get(f.kind) != f.text]
```

`to_messages` makes one developer message, then one user message, each fragment a separate part. [`turn.py`](../../../backends/educodex/src/educodex/core/turn.py) `record_context_updates` calls this at the start of every turn, before the user's message. It records the changed fragments and emits `trace/promptAssembled`, which lists each fragment with its source file, token estimate and a `changed` flag.

The base instructions are *not* in history. [`client.py`](../../../backends/educodex/src/educodex/core/client.py) puts them in front on every request: `"input": [developer_message(prompt.base_instructions), *prompt.input]`.

[`tools/registry.py`](../../../backends/educodex/src/educodex/core/tools/registry.py) keeps tool specs in a stable order, for the same caching reason ("a changing order would break the prompt cache").

## In Codex

- [`build_initial_context_with_world_state`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/mod.rs#L4212) in `core/src/session/mod.rs` builds the first-turn context. It sorts fragments by role, then emits the [developer bundle](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/mod.rs#L4418) and the [user bundle](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/mod.rs#L4438).
- [`build_world_state_for_step`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/world_state.rs#L59) in `core/src/session/world_state.rs` lists the sections, for example [AGENTS.md](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/world_state.rs#L195), [permissions](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/world_state.rs#L216) and [collaboration mode](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/world_state.rs#L236).
- [`record_context_updates_and_set_reference_context_item`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/mod.rs#L4627) emits full context on the first turn and only the diff later. The diff comes from [`render_history_diff`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/context/world_state/mod.rs#L489).
- [`merge_world_state_updates`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/context_manager/updates.rs#L30) in `core/src/context_manager/updates.rs` groups neighbouring fragments of the same role into one message.
- Wrapper tags: [`<permissions instructions>`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/prompts/src/permissions_instructions.rs#L272), [`# AGENTS.md instructions` … `</INSTRUCTIONS>`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/context/user_instructions.rs#L24), [`<environment_context>`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/protocol.rs#L124), [`<collaboration_mode>`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/protocol.rs#L136).
- Permission templates: [`prompts/templates/permissions/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/prompts/templates/permissions). AGENTS.md discovery: [`core/src/agents_md.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/agents_md.rs).
- Base instructions are prepended in [`build_responses_request`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/client.rs#L931). The cache key defaults to the session id in [`prompt_cache_key`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/client.rs#L581).
- The layout snapshots: [`core/tests/suite/snapshots/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/tests/suite/snapshots) (files named `…model_visible_layout…`).

## Where educodex is simpler

- **Five fragments, not twenty.** Codex also has skills, apps, plugins, multi-agent, model-switch, token-budget and time-reminder sections, among others.
- **Text diff, not section snapshots.** Codex keeps a JSON snapshot per section, writes patches of it to the session log, and can rebuild the baseline from history after a resume. educodex compares rendered text in memory.
- **Checked once per turn.** Codex also checks before every model request within a turn ([`record_step_world_state_if_changed`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/turn.rs#L505)). In educodex, settings only change between turns, so once is enough.
- **No model-switch message.** When you change the model, Codex adds a `<model_switch>` developer message. educodex just sends the new base instructions, which changes `input[0]` and loses the cache.
- **Collaboration mode is always Default.** There is no Plan mode.
- **AGENTS.md:** no `project_doc_fallback_filenames` setting.

## Try it

The first lines of every run show prompt assembly: each fragment's role, kind, token count, `+ appended` or `unchanged`, and its source file:

```bash
uv run educodex exec "Say hi"
```

Now add project instructions in a scratch folder and run there:

```bash
mkdir -p /tmp/agents-demo && echo "Always answer in French." > /tmp/agents-demo/AGENTS.md
uv run educodex exec --cwd /tmp/agents-demo "Say hi"
```

A new `agents_md` user fragment appears, and the answer comes in French. Use `-v` to print the full request body.

In the web UI (`uv run educodex app-server`, then http://127.0.0.1:8765):
1. Send a message. Open the **Context** tab: every `input` item, colour-coded by source (base / permissions / AGENTS.md / env / user / model / tool), with token counts. The bar is zoomed to the used part so small items are visible; untick **zoom to used** to see it against the whole context window, with the auto-compact marker.
2. Change the sandbox dropdown (say, to `read-only`) and send another message.
3. Open the **Requests** tab on request #2. It says how many items were appended and whether earlier items stayed unchanged ✓. The new permissions and `<environment_context>` messages sit at the end; item 01 is untouched.

Offline: add `--fake-model examples/fake/demo.json` to `exec` or `app-server`. The prompt assembly lines and the Context and Requests tabs work the same, because the prompt is built locally.

### Watching the cache pay off

The header shows the session's cost and cache hit rate (e.g. `$0.0019 · 84% cached`). The **Context** tab tags every item `cached`, `uncached` or `new` for the last request and estimates what it costs to send again. The **Requests** tab shows each request's bill. Prices come from OpenRouter's `/models` and usage from the response ([`observe/pricing.py`](../../../backends/educodex/src/educodex/observe/pricing.py)); educodex's numbers match OpenRouter's billed `usage.cost` exactly.

A real `gpt-6-luna` turn:

| Request | Input tokens | From cache | Billed |
|---|---|---|---|
| #1 | 5,578 | 0 (5,575 written) | $0.000728 |
| #2 | 5,687 | 5,575 | $0.000080 |

Cached input costs a tenth of normal input. Request #2 repeats #1 as a prefix, so it is about 9x cheaper. One edit to an early message would make every later request a cache miss.

## Further reading
- [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/): the prompt layout, cache-miss causes and "append, don't modify".
- [Prompt caching](https://platform.openai.com/docs/guides/prompt-caching): how OpenAI's cache works and how to read `cached_tokens`.
- [Context Engineering for AI Agents: Lessons from Building Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus): why KV-cache hit rate is the number to watch.
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).
- [Custom instructions with AGENTS.md](https://developers.openai.com/codex/guides/agents-md): discovery and merge order from the user's side.
