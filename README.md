# eduagent

Readable re-implementations of real coding-agent harnesses, with one web UI (the visualiser) that shows every hidden step. The backends are **educodex** (Codex, Python, below) and **edupi** (pi, TypeScript, see [its guide](docs/guide/edupi/README.md)). The repo layout is in [`AGENTS.md`](AGENTS.md#repo-layout).

## Start the launcher

The launcher serves the visualiser and starts one backend process for each viewer (browser tab). It needs Node 22.19 or newer, pnpm and [uv](https://docs.astral.sh/uv/).

```bash
echo 'OPENROUTER_API_KEY=sk-or-...' > .env   # at the repo root; the launcher passes it to every backend
pnpm install && pnpm build                    # build the visualiser once
pnpm eduagent                                 # open http://127.0.0.1:8765
```

Pick a backend and a working directory (prefilled with the directory where you ran `pnpm eduagent`), then click **Open**. To compare backends, open a second viewer (another browser tab) and pick another one. Each viewer gets its own process; closing it stops it. Options: `--port 8765`, `--cwd DIR` (the prefilled directory), `--config FILE` (relative to `launcher/`).

The backends are listed in [`launcher/backends.json`](launcher/backends.json). Each entry has a `name`, the `harness` it re-implements, the `protocol` it speaks, the `command` to run (an argv list, no shell, `${REPO}` and `${ENV_VAR}` are replaced), an optional `env`, and `capabilities`. For machine-specific entries, create `launcher/backends.local.json` in the same format. It is git-ignored, and an entry there replaces the shared entry with the same name. For the visualiser's hot reload, run `pnpm --filter @eduagent/visualiser dev` next to the launcher; Vite forwards `/backends` and `/guide` to it.

## edupi

**A readable TypeScript re-implementation of the [pi](https://github.com/earendil-works/pi) harness** at the pinned commit `16f5f0af4`. It speaks pi's RPC protocol over stdio, so the visualiser uses the same adapter for edupi and for the real pi. It calls OpenRouter's Chat Completions endpoint with the OpenAI SDK; the default model is `openai/gpt-6-luna`, as for educodex. Pick **edupi** in the launcher. Its code is in `backends/edupi/`, its tests run with `pnpm test`, and its guide is [`docs/guide/edupi/`](docs/guide/edupi/README.md).

## The real pi

The real [pi](https://github.com/earendil-works/pi) harness can run in a viewer too, to compare it with the backends. It is chat only: no trace events, no step mode, no context inspector. Its entry is machine-specific, so it goes in the git-ignored `launcher/backends.local.json`:

1. Check out pi at the pinned commit `16f5f0af4`, and install its dependencies as the commit locks them (Node 22.19 or newer):
   ```bash
   git clone https://github.com/earendil-works/pi ../pi && cd ../pi && git checkout 16f5f0af4
   npm ci && npm run hydrate:model-data   # hydrate fetches public model catalogs (no API key)
   ```
2. Copy [`launcher/backends.local.example.json`](launcher/backends.local.example.json) to `launcher/backends.local.json`, and set `PI_DIR` to the pi checkout (in `.env`, for example `PI_DIR=/path/to/pi`, or replace `${PI_DIR}` in the file).
3. Start `pnpm eduagent` and pick **pi**.

The entry runs pi from source in RPC mode (`node --import <pi>/packages/coding-agent/src/experimental/source-resolver.ts <pi>/packages/coding-agent/src/cli.ts --mode rpc`), not a globally installed `pi`, which can drift from the pin. It uses OpenRouter with `openai/gpt-6-luna` and your `OPENROUTER_API_KEY`. Its home is `~/.eduagent/.pi/agent` (`PI_CODING_AGENT_DIR`), so it does not touch `~/.pi`. To run it with no API key, start the fake model server (`node visualiser/test/fake-chat-completions.mjs 18787 script.json`) and point pi at it with a `models.json` in its agent folder: `{"providers": {"openrouter": {"baseUrl": "http://127.0.0.1:18787/v1", "apiKey": "fake"}}}`.

The pi adapter is tested on transcripts recorded from this checkout (`visualiser/test/fixtures/pi/`), and edupi's tests on pi's session files and request bodies (`backends/edupi/test/fixtures/pi/`, scenarios `session-prompt-and-tools` and `session-compact`). To record them again, run `node visualiser/test/record-pi.mjs [scenario...]` (set `PI_DIR` if pi is not at `../pi`), then update the ids and times that `visualiser/test/pi-adapter.test.ts` pins. edupi's tests read ids, times and the cwd from the fixtures, so they need no update.

## educodex

**An educational Python re-implementation of the [OpenAI Codex](https://github.com/openai/codex) harness, in which every hidden step is visible.**

Production coding agents hide most of what they do: how the prompt is assembled, the exact request sent to the model, why a command was allowed or blocked, and how an MCP tool ends up in the tool list. educodex keeps Codex's design, names and wire formats, drops everything that exists only for scale, and shows every step in a web UI.

```
web UI (React) ─┐
TUI (Textual) ──┼── JSON-RPC lite ──► app server ──► core: loop · prompt · tools · policy · sandbox
CLI ────────────┘                                     ├─► OpenRouter Responses API (OpenAI models)
                                                      └─► MCP servers
```

- **Same wire format as Codex.** It uses the stateless Responses API (`store: false`, full history on every call), base instructions as the first developer message, the freeform `apply_patch` tool with Codex's Lark grammar, `exec_command`/`write_stdin`, and MCP namespace tools.
- **Codex's own prompts.** System prompts, permission texts, the compaction prompt and the Seatbelt sandbox policies are copied from Codex at a pinned commit (`backends/educodex/src/educodex/vendor/codex/`).
- **Real guardrails.** Approval policies, a dangerous-command check, exec-policy prefix rules, and the macOS `sandbox-exec` sandbox.
- **Every module names the Codex file it mirrors.** A guide in [`docs/guide/educodex/`](docs/guide/educodex/README.md) walks from basics to advanced topics.

## Quick start

Run these from `backends/educodex/`. The `.env` file can sit there or at the repo root.

```bash
echo 'OPENROUTER_API_KEY=sk-or-...' > .env      # uses openai/gpt-6-luna via OpenRouter by default
uv sync --group dev

# One task in the terminal, printing every step (-v adds raw JSON)
uv run educodex exec --cwd /path/to/project "Fix the failing test"

# The web UI: start the launcher at the repo root (see above) and pick educodex
(cd ../.. && pnpm install && pnpm build && pnpm eduagent --cwd /path/to/project)

# The app server alone, speaking JSONL on stdin/stdout (what the launcher runs).
# It has no web server: stdio is its only transport, as Codex's default.
uv run educodex app-server

# Offline: a scripted fake model, no API key needed
uv run educodex exec --cwd /tmp/demo --fake-model examples/fake/demo.json "go"

# The terminal UI (it uses the same protocol as the web UI, over stdio)
uv run --group dev educodex tui --cwd /path/to/project

# An MCP server
uv run educodex exec --mcp notes="python examples/mcp/notes_server.py" "List my notes"
```

Options: `--approval on-request|never`, `--sandbox read-only|workspace-write|danger-full-access`, `--effort low|medium|high`, `--network`, `--model openai/<slug>`, `--memories`.

In the web UI and the TUI, type `/` for commands (`/skills`, `/new`, `/compact`, `/memory-update`, `/memory-drop`) and `$` to use a skill. Skills are `SKILL.md` folders in `.agents/skills/` of your project or `~/.agents/skills/`.

**Home folder.** educodex keeps sessions, rules, skills and memories in `~/.eduagent/.educodex` (laid out as `~/.codex`). Set `EDUCODEX_HOME` to use another folder. The home used to be `~/.educodex`. If you have one, move it by hand: `mkdir -p ~/.eduagent && mv ~/.educodex ~/.eduagent/.educodex`.

## What the web UI shows

| Panel | Shows |
|---|---|
| Chat | Messages, commands with live output, diffs, MCP calls, plans, memory updates, and approval prompts that pause the turn |
| Timeline | Every protocol and `trace/*` event, each with a plain-language explanation and links to the guide and the Codex code |
| Context | The exact `input` array of the next request, coloured by where each item came from, against the context window |
| Requests | The raw body of every model call, plus a check that each request extends the previous one (so the prompt cache can hit) |
| Tools | Tool specs as the model sees them, and an MCP server's raw `tools/list` next to the spec the model gets |
| Guardrails | Policy decisions, the `sandbox-exec` command and its Seatbelt policy, approvals |
| Protocol | Raw JSON-RPC lite messages |

Turn on **step mode** to pause before every model request and tool call.

## Tests

```bash
cd backends/educodex && uv run --group dev pytest   # core, policy, sandbox, MCP, app server, TUI
pnpm test                                           # at the repo root. vitest: adapters on recorded transcripts (educodex, real pi)
pnpm test:e2e                                       # at the repo root. Playwright: the launcher with launcher/backends.test.json (fake model)
```

## Format and lint

TypeScript and JavaScript use [Biome](https://biomejs.dev) (`biome.jsonc`, pi's style: tabs, indent width 3, line width 120). educodex uses [Ruff](https://docs.astral.sh/ruff/) (`[tool.ruff]` in `backends/educodex/pyproject.toml`, line length 120). `.editorconfig` matches both. Run them before you commit (agents must):

```bash
pnpm format                                         # at the repo root: biome check --write (format, sort imports, safe fixes)
pnpm lint                                           # at the repo root: biome check (pnpm test runs it too)
cd backends/educodex && uv run ruff format && uv run ruff check
```

The bulk formatting commit is listed in `.git-blame-ignore-revs`. To skip it in `git blame`, run once: `git config blame.ignoreRevsFile .git-blame-ignore-revs`.

## Layout

Paths are relative to `backends/educodex/`, except the last two rows.

| Path | What |
|---|---|
| `src/educodex/core/` | The Codex harness; never imports `observe/` or the hosts |
| `src/educodex/core/turn.py` | The agentic loop (`codex-rs/core/src/session/turn.rs`) |
| `src/educodex/core/client.py` | Responses API request and SSE parsing (`core/src/client.rs`) |
| `src/educodex/core/context/` | Prompt fragments and world-state diffs (`core/src/context/`, `prompts/`) |
| `src/educodex/core/tools/` | `exec_command`, `write_stdin`, `apply_patch`, `update_plan` (`core/src/tools/`, `apply-patch/`) |
| `src/educodex/core/policy/`, `sandbox/` | Approvals, rules, dangerous commands, Seatbelt (`core/src/exec_policy.rs`, `sandboxing/`) |
| `src/educodex/core/mcp/` | MCP client and tool exposure (`codex-mcp/`) |
| `src/educodex/core/skills/` | Skill discovery, the catalog, `$name` injection (`skills/`, `ext/skills/`) |
| `src/educodex/core/memories/` | Memories: read path and the two-phase write path (`memories/`, `ext/memories/`) |
| `src/educodex/core/probe.py` | No-op observability hooks the core calls (like Codex's OpenTelemetry calls, `otel/`) |
| `src/educodex/observe/` | educodex only: `trace/*` events (`Tracer`), costs, step mode |
| `src/educodex/app_server/` | JSON-RPC lite server over stdio (`app-server/`, `app-server-protocol/`, `app-server-transport/`) |
| `visualiser/` (repo root) | React UI |
| `docs/design.md`, `docs/guide/educodex/` (repo root) | Design and the guide |

Codex files under `src/educodex/vendor/codex/` are Apache-2.0 (see its `LICENSE`/`NOTICE`). Re-sync them with `uv run scripts/sync_vendor.py [path/to/codex]` from `backends/educodex/`.
