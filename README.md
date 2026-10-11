# educodex

**An educational Python re-implementation of the [OpenAI Codex](https://github.com/openai/codex) harness, in which every hidden step is visible.**

Production coding agents hide most of what they do: how the prompt is assembled, the exact request sent to the model, why a command was allowed or blocked, and how an MCP tool ends up in the tool list. educodex keeps Codex's design, names and wire formats, drops everything that exists only for scale, and shows every step in a web UI.

```
web UI (React) ─┐
TUI (Textual) ──┼── JSON-RPC lite ──► app server ──► core: loop · prompt · tools · policy · sandbox
CLI ────────────┘                                     ├─► OpenRouter Responses API (OpenAI models)
                                                      └─► MCP servers
```

- **Same wire format as Codex.** It uses the stateless Responses API (`store: false`, full history on every call), base instructions as the first developer message, the freeform `apply_patch` tool with Codex's Lark grammar, `exec_command`/`write_stdin`, and MCP namespace tools.
- **Codex's own prompts.** System prompts, permission texts, the compaction prompt and the Seatbelt sandbox policies are copied from Codex at a pinned commit (`src/educodex/vendor/codex/`).
- **Real guardrails.** Approval policies, a dangerous-command check, exec-policy prefix rules, and the macOS `sandbox-exec` sandbox.
- **Every module names the Codex file it mirrors.** A guide in [`docs/guide/`](docs/guide/README.md) walks from basics to advanced topics.

## Quick start

```bash
echo 'OPENROUTER_API_KEY=sk-or-...' > .env      # uses openai/gpt-6-luna via OpenRouter by default
uv sync --group dev

# One task in the terminal, printing every step (-v adds raw JSON)
uv run educodex exec --cwd /path/to/project "Fix the failing test"

# The web UI
(cd web && pnpm install && pnpm build)
uv run educodex app-server --cwd /path/to/project     # open http://127.0.0.1:8765

# Offline demo: a scripted fake model, no API key needed
uv run educodex app-server --cwd /tmp/demo --fake-model examples/fake/demo.json

# The terminal UI (it uses the same protocol as the web UI, over stdio)
uv run --group dev educodex tui --cwd /path/to/project

# An MCP server
uv run educodex exec --mcp notes="python examples/mcp/notes_server.py" "List my notes"
```

Options: `--approval on-request|never`, `--sandbox read-only|workspace-write|danger-full-access`, `--effort low|medium|high`, `--network`, `--model openai/<slug>`.

## What the web UI shows

| Panel | Shows |
|---|---|
| Chat | Messages, commands with live output, diffs, MCP calls, plans, and approval prompts that pause the turn |
| Timeline | Every protocol and `trace/*` event, each with a plain-language explanation and links to the guide and the Codex code |
| Context | The exact `input` array of the next request, coloured by where each item came from, against the context window |
| Requests | The raw body of every model call, plus a check that each request extends the previous one (so the prompt cache can hit) |
| Tools | Tool specs as the model sees them, and an MCP server's raw `tools/list` next to the spec the model gets |
| Guardrails | Policy decisions, the `sandbox-exec` command and its Seatbelt policy, approvals |
| Protocol | Raw JSON-RPC lite messages |

Turn on **step mode** to pause before every model request and tool call.

## Tests

```bash
uv run --group dev pytest           # core, policy, sandbox, MCP, app server, TUI
cd web && pnpm test:e2e             # Playwright: drives the web UI against the fake model
```

## Layout

| Path | What |
|---|---|
| `src/educodex/core/` | The Codex harness; never imports `observe/` or the hosts |
| `src/educodex/core/turn.py` | The agentic loop (`codex-rs/core/src/session/turn.rs`) |
| `src/educodex/core/client.py` | Responses API request and SSE parsing (`core/src/client.rs`) |
| `src/educodex/core/context/` | Prompt fragments and world-state diffs (`core/src/context/`, `prompts/`) |
| `src/educodex/core/tools/` | `exec_command`, `write_stdin`, `apply_patch`, `update_plan` (`core/src/tools/`, `apply-patch/`) |
| `src/educodex/core/policy/`, `sandbox/` | Approvals, rules, dangerous commands, Seatbelt (`core/src/exec_policy.rs`, `sandboxing/`) |
| `src/educodex/core/mcp/` | MCP client and tool exposure (`codex-mcp/`) |
| `src/educodex/core/probe.py` | No-op observability hooks the core calls (like Codex's OpenTelemetry calls, `otel/`) |
| `src/educodex/observe/` | educodex only: `trace/*` events (`Tracer`), costs, step mode |
| `src/educodex/app_server/` | JSON-RPC lite server (`app-server/`, `app-server-protocol/`) |
| `web/` | React UI |
| `docs/design.md`, `docs/guide/` | Design and the guide |

Codex files under `src/educodex/vendor/codex/` are Apache-2.0 (see its `LICENSE`/`NOTICE`). Re-sync them with `uv run scripts/sync_vendor.py ../codex`.
