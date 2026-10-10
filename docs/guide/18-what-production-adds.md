# 18 — What production adds

## Concept

educodex keeps Codex's *ideas*: the loop, the prompt layout, the tools, the guardrails, compaction and the App Server. It drops nearly everything else. Codex has about 2 million lines of Rust. Most of that code exists for one of four reasons:

| Reason | Examples |
|---|---|
| **Speed and cost** | WebSocket transport, prewarm, incremental requests, prompt-cache care |
| **Reliability** | Retries, fallbacks, remote compaction |
| **More capability** | Sub-agents, skills, plugins, apps, code mode |
| **More places to run safely** | Linux and Windows sandboxes, network proxy, auto-review, many UIs, cloud |

This chapter is a map. Each entry says what the feature is, why it exists, and where to start reading in Codex. All paths are at the pinned commit.

## In educodex

What educodex does instead, in one table:

| Production feature | educodex |
|---|---|
| Model transport | One HTTP POST + SSE per request ([`client.py`](../../src/educodex/core/client.py)); full history every time |
| Retries | Up to 3 attempts for connection errors, 429 and 5xx, and only before the first event arrives |
| Compaction | Local, plain-text summary only ([`compact.py`](../../src/educodex/core/compact.py), chapter 14) |
| Sandbox | macOS Seatbelt only ([`sandbox/seatbelt.py`](../../src/educodex/core/sandbox/seatbelt.py)) |
| Approvals | A human answers every prompt (chapter 09) |
| Telemetry | `trace/*` events shown in the UI (chapter 17) |
| Providers | OpenAI models through OpenRouter's Responses API |
| Tool calling | Classic `tools` for every model, as Codex does for `gpt-5.5`. No code mode, no Responses Lite (chapter 06) |

## In Codex

### Talking to the model faster

**WebSocket transport, prewarm and `previous_response_id`.** Over HTTP, every request re-sends the whole history (chapter 02). Codex can instead keep a WebSocket open to the Responses API for the whole turn. Then it only sends the *new* items plus `previous_response_id`. This is safe only when nothing else in the request changed: same model, tools, reasoning settings, `prompt_cache_key` and so on. [`responses_request_properties_match`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/client.rs#L341) checks this. **Prewarm** sends a `response.create` with `generate=false` before the first real request, so the connection and server state are ready ([module docs](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/client.rs#L17), [`prewarm_websocket`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/client.rs#L2176)). The wire side is in [`codex-api/src/endpoint/responses_websocket.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/codex-api/src/endpoint/responses_websocket.rs). *Why:* long turns send megabytes of the same JSON again and again. The [Unrolling](https://openai.com/index/unrolling-the-codex-agent-loop/) post (Jan 2026) says Codex did not use `previous_response_id`, to stay stateless and support Zero Data Retention. The WebSocket path is how it gets the speed-up anyway.

**Retries and fallback.** Networks drop and servers return 429/5xx. [`core/src/responses_retry.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/responses_retry.rs#L23) decides when to retry, how long to wait (respecting server `Retry-After`) and when to fall back from WebSocket to HTTP. The backoff itself is in [`codex-client/src/retry.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/codex-client/src/retry.rs#L43). Retry limits per provider are capped in [`model-provider-info`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/model-provider-info/src/lib.rs#L72). *Why:* a turn can last hours, and one network blip should not throw it away.

**Prompt-cache care.** A cache hit needs an exact prefix match. Codex [chooses a stable `prompt_cache_key`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/client.rs#L581), appends settings changes as new messages instead of editing old ones ([`session/world_state.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/world_state.rs), chapter 05), and keeps tool order stable. When compaction is too big, it drops the *oldest* item "to preserve cache" ([`compact.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/compact.rs#L344)). *Why:* with cache hits, each request costs roughly the new tokens, not the whole history. educodex copies the append-only part and sends `prompt_cache_key` (the Requests tab checks the prefix), but it has no tests that guard against cache-breaking changes.

**Responses Lite.** For models marked `use_responses_lite: true` (most of today's catalog, including `gpt-6-luna`), Codex leaves the top-level `tools` field empty. It puts the tool list into `input` as one `additional_tools` item with role `developer`, and sends `parallel_tool_calls: false` ([`client.rs` ~L915](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/client.rs#L915), [L1001](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/client.rs#L1001)). The item gets a stable id derived from the thread id and the tool list, so it is cache-friendly too. *Why:* a lighter request shape that these models were trained on. educodex records the flag (`codex_use_responses_lite`) and notes it in `trace/toolsRegistered`, but always uses the classic layout.

**Remote compaction.** The server summarises and returns an encrypted `compaction` item ([`compact_remote_v2.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/compact_remote_v2.rs#L430), triggered by a [`compaction_trigger`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/compact_remote_v2_attempt.rs#L95) item). *Why:* it keeps more than a text summary can. See chapter 14.

### Doing more

**Sub-agents (multi-agent).** The model can call `spawn_agent`, `send_message`, `wait_agent` and similar tools ([`multi_agents_spec.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L92), [`multi_agents_v2/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/handlers/multi_agents_v2)). Each child is its own thread with its own context ([`core/src/agent/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/agent)), and roles come from [`agent-roles/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/agent-roles). *Why:* a sub-agent can read 50 files and return one paragraph, so the parent's context stays small. Independent work can also run in parallel.

**Skills.** A skill is a folder with a `SKILL.md` ([`skills/src/mentions.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/skills/src/mentions.rs#L40)). Only its name and short description go into the prompt; the model reads the full file when it needs it. *Why:* you can have many specialised instructions without paying for all of them in every request.

**Plugins and apps.** Plugins bundle skills, MCP servers and hooks into one installable package ([`plugin/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/plugin/src), [`core-plugins/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core-plugins/src)). Apps (connectors) bring hosted integrations in as tools ([`connectors/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/connectors/src)). *Why:* teams want to share a setup, not copy config files around.

**Code mode.** Instead of one tool call per step, the model writes JavaScript that calls tools as functions (`await tools.exec_command(...)`). It goes through one freeform tool named `exec` (plus `wait` for long runs), and runs "in a fresh V8 isolate" with no file system or network of its own. The catalog turns it on per model: `tool_mode: "code_mode_only"` means the model sees *only* `exec`, and every other tool is reachable just from inside the JavaScript. That is how Codex runs `gpt-6-luna` and most current models; `gpt-5.5` (`tool_mode: null`) still gets classic tools. Where to read:
- the tool description and its `tools.*` rules: [`code-mode-protocol/src/description.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/code-mode-protocol/src/description.rs#L23);
- the `exec` tool spec and its grammar: [`core/src/tools/code_mode/execute_spec.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/code_mode/execute_spec.rs#L5), with the handlers next to it in [`core/src/tools/code_mode/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/code_mode);
- choosing the mode and registering `exec`/`wait`: [`effective_tool_mode`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/mod.rs#L87) and [`register_code_mode_executors`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/spec_plan.rs#L863);
- the sessions that run the JavaScript: [`code-mode/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/code-mode/src) (in-process or over gRPC), with the V8 side in [`code-mode-runtime/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/code-mode-runtime).

*Why:* loops and filtering happen in code. Fewer model round-trips, and big intermediate results never enter the context. educodex keeps classic tool calls because each step is then a visible item, which is easier to learn from (chapter 06).

### Running safely in more places

**Auto-review (guardian).** Instead of asking you, a separate reviewer model decides whether a risky action is allowed. It follows a written policy ([`prompts/templates/guardian/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/prompts/templates/guardian)), and the code lives in [`core/src/guardian/`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/guardian/mod.rs#L1). *Why:* people approve prompts without reading them after the tenth one. A reviewer with the full context can say yes to safe things and stop the agent only for the risky ones.

**Linux and Windows sandboxes.** Linux uses bubblewrap (namespaces) and Landlock ([`linux-sandbox/`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/linux-sandbox/README.md), [`sandboxing/src/bwrap.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/sandboxing/src/bwrap.rs), [`sandboxing/src/landlock.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/sandboxing/src/landlock.rs)). Windows uses restricted tokens, ACLs and a separate sandbox user ([`windows-sandbox-rs/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/windows-sandbox-rs/src)). *Why:* every OS has a different isolation API, and Windows has nothing like `sandbox-exec`. See [Building a safe, effective sandbox to enable Codex on Windows](https://openai.com/index/building-codex-windows-sandbox/).

**Network proxy.** Sandboxed commands can reach the network only through a local HTTP/SOCKS5 proxy that applies an allow/deny list ([`network-proxy/`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/network-proxy/README.md)). *Why:* "network on or off" is too coarse. `pip install` should work, but uploading your code to an unknown host should not (the "lethal trifecta", chapter 11).

**OpenTelemetry.** [`otel/`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/otel/README.md) exports logs, traces and metrics for sessions, tool calls and approvals. *Why:* companies need to see what agents did across a whole fleet, not one UI at a time.

### More surfaces

**TUI, IDEs and desktop.** The Rust [`tui/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/tui) talks to the App Server through [`app-server-client/`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-client/src/lib.rs#L1). The VS Code extension and desktop app are not in this repo. They ship a pinned Codex binary and speak JSON-RPC over stdio to `codex app-server` (chapter 16). *Why:* one harness, many front ends.

**Cloud tasks.** [`cloud-tasks/`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/cloud-tasks/src/cli.rs) submits and tracks Codex Cloud tasks from the CLI. In the cloud, the App Server runs inside a container next to the checked-out repo. *Why:* long tasks keep running when your laptop sleeps, and many can run at once.

**Multiple providers.** [`model-provider/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/model-provider/src) describes what each provider supports, for example remote compaction ([`capabilities.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/model-provider/src/capabilities.rs#L33)). There is built-in support for [Amazon Bedrock](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/model-provider/src/amazon_bedrock), and local models via [`ollama/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/ollama/src) and [`lmstudio/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/lmstudio/src). All of them speak the Responses API: it is the only [`WireApi`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/model-provider-info/src/lib.rs#L107) left. *Why:* enterprise data rules, offline use, and cost.

**Evals and tests.** The public tree has no eval suite. What it has is a large integration test suite ([`core/tests/suite/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/tests/suite), about 240 files) that runs the harness against a mock Responses server. It includes snapshot tests of the exact model-visible prompt layout. *Why:* a harness change that reorders the prompt can silently break caching or model behaviour. Snapshots catch that.

Not covered here, but also in the tree: realtime voice ([`realtime-webrtc/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/realtime-webrtc)), long-term memories ([`memories/`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/memories/README.md)) and review mode ([`prompts/templates/review/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/prompts/templates/review)).

## Where educodex is simpler

All of the above. The point of educodex is that you can read it in an afternoon. A good exercise is to pick one feature and add it:
- **Better retries** in `client.py`: honour the server's `Retry-After` header, and add backoff with jitter. Keep the rule that retries happen only *before* any output item has been recorded, so items are never added twice.
- **A sub-agent tool**: start a second `Session` with its own history, run one turn, and return its last message as the tool output.
- **A network allow-list**: start the sandbox without network, and route `HTTP_PROXY` to a tiny proxy that checks host names.
- **A prompt snapshot test**: freeze `fake.requests[0]["input"]` roles and texts, and fail when they change.

## Try it

1. Find each feature in your own Codex install: `codex --help`, and `codex features list` shows each feature flag with its stage and whether it is on. `codex features enable <name>` writes it to `~/.codex/config.toml`.
2. In educodex, open the **Requests** tab after a few tool calls. Each request repeats everything before it. That repetition is exactly what WebSocket incremental requests and prompt caching are designed to make cheap.
3. Compare the size of the two trees:
   ```bash
   find src/educodex -name '*.py' | xargs wc -l | tail -1
   find ../codex/codex-rs -name '*.rs' | xargs wc -l | tail -1
   ```

## Further reading
- [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/): performance, prompt caching, ZDR and compaction.
- [Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/): the surfaces built on the App Server.
- [Building a safe, effective sandbox to enable Codex on Windows](https://openai.com/index/building-codex-windows-sandbox/).
- [Sandboxing](https://developers.openai.com/codex/concepts/sandboxing) and [Auto-review](https://developers.openai.com/codex/concepts/sandboxing/auto-review): the user-facing side of sandboxes and guardian.
- [Harness engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/): what changes when agents write most of the code.
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents): sub-agents and just-in-time context, the ideas behind skills.
