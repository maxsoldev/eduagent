# AGENTS.md

eduagent is a suite of readable re-implementations (backends) of real coding-agent harnesses, with one shared visualiser. Students read this code to learn how the harnesses work and how they differ. See `README.md`, `GLOSSARY.md` and `docs/adr/`.

## Repo layout

| Path | What |
|---|---|
| `backends/educodex/` | educodex, the Codex backend (Python): `src/educodex/`, `tests/`, `scripts/`, `examples/`, `spikes/`, `pyproject.toml`, `uv.lock` |
| `backends/edupi/` | edupi, the pi backend (TypeScript, run with tsx): `src/ai/`, `src/agent/`, `src/coding-agent/` mirror pi's packages; `test/` (vitest over stdio, with the faux provider); `bin/edupi.mjs` |
| `visualiser/` | The shared web UI (React, Vite, Playwright tests in `e2e/`) |
| `launcher/` | Serves the visualiser and starts one stdio backend per viewer (TypeScript, tsx). Backend list in `backends.json`; `backends.local.json` is git-ignored; `backends.test.json` is for Playwright |
| `docs/guide/<backend>/` | The guide, one section per backend (`docs/guide/educodex/`, `docs/guide/edupi/`) |
| `docs/design.md` | educodex design |
| `docs/adr/`, `GLOSSARY.md` | Architecture decisions and domain terms for the suite |
| `package.json`, `pnpm-workspace.yaml` | The root pnpm workspace (members: `visualiser`, `launcher`, `backends/edupi`) |

## Harness sources

| Backend | Harness | Local checkout | Pinned commit |
|---|---|---|---|
| educodex | Codex | `/Users/max/edu/agents/codex` (Rust code in `codex-rs/`) | `1c7c43cd85` (`1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d`, 2026-10-07) |
| edupi | pi | `/Users/max/edu/agents/pi` | `16f5f0af4` (`16f5f0af4d85ca583d045ceb5ed6d646fcaf7761`) |

Guide links use the pinned commit.

## How to port a harness feature (every backend)

- Keep the core logic as close as possible to the harness: same names, prompts, wire formats and order of steps. When unsure, copy the harness's behaviour.
- Leave out optimisations, performance work, caching, telemetry and other complications on top. The code must stay readable for students.
- Every module names the harness file it mirrors. Record deliberate simplifications in the guide chapter's "Where <backend> is simpler" block.
- The core never imports the teaching extras (`observe/`) or the hosts. A layer test checks this.
- A feature is not done until its chapter in `docs/guide/<backend>/` is written: concept, backend code, harness permalinks at the pinned commit, further reading.

### educodex only

- OpenAI models only for now (via OpenRouter Responses API, default `openai/gpt-6-luna`). Do not add provider abstractions.
- `core/` never imports `observe/`, `app_server/` or the CLI/TUI (`backends/educodex/tests/test_layers.py`). Teaching extras go in `observe/` via the `Probe` hooks.
- Vendored Codex files live in `backends/educodex/src/educodex/vendor/codex/`. Do not edit them by hand; re-run `uv run scripts/sync_vendor.py [path/to/codex]` from `backends/educodex/` (default: the `codex` checkout next to the repo).
- Home: `~/.eduagent/.educodex` (laid out as `~/.codex`); `EDUCODEX_HOME` overrides it.
- `educodex app-server` speaks stdio only (Codex's default transport). It has no web server; the launcher serves the visualiser and the guide. Test it over stdio with the `app_server` fixture in `backends/educodex/tests/conftest.py`.

### edupi only

- Each file starts with the pi file it mirrors at `16f5f0af4`. Folders and file names follow pi's packages (`packages/ai/src` → `src/ai`, `packages/agent/src` → `src/agent`, `packages/coding-agent/src` → `src/coding-agent`).
- The core is `src/ai/`, `src/agent/` and `src/coding-agent/core/`. It never imports `src/observe/`, `src/coding-agent/modes/`, `src/coding-agent/cli/` or `main.ts` (`backends/edupi/test/layers.test.ts`).
- Dependencies are pi's own only: the OpenAI SDK (pointed at OpenRouter), and later typebox, diff and yaml.
- `edupi --mode rpc` speaks pi's RPC protocol unchanged. Test it over stdio with `startEdupi(script)` in `backends/edupi/test/rpc-client.ts`; `--faux script.json` replaces OpenRouter with the faux provider, `--faux-log file` records each request body.

## Commands

```bash
cd backends/educodex && uv run --group dev pytest   # educodex Python tests
pnpm install && pnpm build                          # at the repo root: build the visualiser
pnpm test                                           # at the repo root: vitest for the visualiser and edupi (edupi also typechecks)
pnpm test:e2e                                       # at the repo root: Playwright tests (starts the launcher with backends.test.json)
pnpm eduagent                                       # at the repo root: start the launcher on http://127.0.0.1:8765
```

## Agent skills

### Issue tracker

GitHub Issues in `maxsoldev/eduagent`, via `gh` as the `neuromaxer` account. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
