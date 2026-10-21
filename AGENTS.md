# AGENTS.md

educodex is an educational Python re-implementation of the OpenAI Codex harness. Students read this code to learn how Codex works. See `README.md` and `docs/design.md`.

## Codex source

- Local checkout: `/Users/max/edu/agents/codex` (Rust code in `codex-rs/`).
- Pinned commit: `1c7c43cd85` (`1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d`, 2026-10-07). Guide links use this commit.
- Vendored Codex files live in `src/educodex/vendor/codex/`. Do not edit them by hand; re-run `uv run scripts/sync_vendor.py ../codex`.

## How to port a Codex feature

- Keep the core logic as close as possible to Codex: same names, prompts, wire formats and order of steps. When unsure, copy Codex's behaviour.
- Leave out optimisations, performance work, caching, telemetry and other complications on top. The code must stay readable for students.
- Every module names the Codex file it mirrors. Record deliberate simplifications in the guide chapter's "Where educodex is simpler" block.
- OpenAI models only for now (via OpenRouter Responses API, default `openai/gpt-6-luna`). Do not add provider abstractions.
- `core/` never imports `observe/`, `app_server/` or the CLI/TUI (`tests/test_layers.py`). Teaching extras go in `observe/` via the `Probe` hooks.
- A feature is not done until its chapter in `docs/guide/` is written: concept, educodex code, Codex permalinks at the pinned commit, further reading.

## Commands

```bash
uv run --group dev pytest        # Python tests
cd web && pnpm test:e2e          # Playwright tests for the web UI
```

## Agent skills

### Issue tracker

GitHub Issues in `maxsoldev/eduagent`, via `gh` as the `neuromaxer` account. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
