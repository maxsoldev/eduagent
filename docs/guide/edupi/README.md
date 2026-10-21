# How pi works, with edupi

This is the edupi section of the eduagent guide. edupi is a readable TypeScript re-implementation of the [pi](https://github.com/earendil-works/pi) coding-agent harness. It keeps pi's names, prompts, wire formats and order of steps, and leaves out the rest.

Read the [educodex section](../educodex/README.md) first. It explains the concepts from scratch: what a harness is, the agent loop, tools, skills, compaction. This section has chapters only where pi differs from Codex, and each chapter links to the matching educodex chapter.

Paths in this section are relative to `backends/edupi/`, where edupi's package lives.

## How to read each chapter

| Block | Meaning |
|---|---|
| **Concept** | What pi does here, and why |
| **In edupi** | Our TypeScript code in `src/` |
| **In pi** | The pi code it mirrors, linked at the pinned commit |
| **How Codex does it differently** | The same job in Codex (and educodex) |
| **Where edupi is simpler** | What we left out or changed, and why |
| **Try it** | Something to run, in the web UI or over stdio |
| **Further reading** | Docs and posts |

## The code

edupi's folders mirror pi's packages. File names follow pi's wherever a file survives, and every file starts with the pi file it mirrors.

| edupi folder | pi package | What it is |
|---|---|---|
| `src/ai/` | `packages/ai/src/` | Provider layer: message types, the Chat Completions API, the OpenRouter and faux providers |
| `src/agent/` | `packages/agent/src/` | Agent layer: the agent loop, the `Agent` class, event types |
| `src/coding-agent/core/` | `packages/coding-agent/src/core/` | Coding-agent core: `AgentSession`, the session manager and session files, the tools (`core/tools/`: read, bash, edit, write), compaction, settings, the model registry |
| `src/coding-agent/config.ts` | `packages/coding-agent/src/config.ts` | edupi's home: `~/.eduagent/.edupi/agent` (laid out as `~/.pi/agent`), or `$EDUPI_CODING_AGENT_DIR` |
| `src/coding-agent/modes/` | `packages/coding-agent/src/modes/` | RPC mode over stdio |
| `src/coding-agent/main.ts` | `packages/coding-agent/src/main.ts` | Arguments and wiring |

`ai`, `agent` and `coding-agent/core` are the **core**. The core never imports the hosts (`modes/`, `main.ts`, `cli/`) or the teaching extras (`src/observe/`). `test/layers.test.ts` checks this.

edupi runs on Node 22.19 or newer with [tsx](https://tsx.is/), with no build step: `bin/edupi.mjs` registers tsx and starts `main()`.

## The web UI

edupi speaks only stdio, as `pi --mode rpc` does. To use it in the web UI, start the launcher at the repo root and pick **edupi**:

```bash
(cd ../.. && pnpm install && pnpm build)   # once: build the visualiser
(cd ../.. && pnpm eduagent)                # then open http://127.0.0.1:8765 and pick edupi
```

The `edupi` entry calls OpenRouter and needs `OPENROUTER_API_KEY` in the repo-root `.env`. The default model is `openai/gpt-6-luna`, the same as educodex, so a comparison shows harness differences, not model differences.

**Offline.** Add an entry with the faux provider to `launcher/backends.local.json` (git-ignored) and restart the launcher. The chapters call it **edupi-faux**:

```json
{ "backends": [
  { "name": "edupi-faux", "harness": "pi", "protocol": "pi-rpc",
    "command": ["node", "${REPO}/backends/edupi/bin/edupi.mjs", "--mode", "rpc",
                "--faux", "${REPO}/backends/edupi/examples/faux/demo.json"],
    "capabilities": ["trace", "compaction"] }
] }
```

`examples/faux/tools.json` is a second script: it calls write and bash in parallel, then edit (chapter 04). `examples/faux/compact.json` has replies for a manual compaction (chapter 07).

List the capabilities edupi has (as in `launcher/backends.json`), or the viewer hides their panels: `trace` shows the Requests and Tools tabs, `compaction` the compact button and `/compact`.

For another model, add `"--model", "<any OpenRouter model id>"` to `command`.

**Over stdio, without the UI.** Type pi RPC commands into edupi directly:

```bash
node bin/edupi.mjs --mode rpc --faux examples/faux/demo.json
{"id":"1","type":"get_state"}
{"id":"2","type":"prompt","message":"Say hello."}
```

**Pinned pi version:** [`16f5f0af4`](https://github.com/earendil-works/pi/tree/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761). Links point to this commit, so line numbers stay valid.

## Chapters

| # | Chapter | You will learn | educodex chapter |
|---|---|---|---|
| 01 | [The provider API](01-provider-api.md) | Chat Completions vs Responses; OpenRouter as an OpenAI-compatible endpoint; pi's provider layer and its faux provider | [02](../educodex/02-talking-to-a-model.md) |
| 04 | [Tools](04-tools.md) | pi's read, bash, edit and write; what the model reads vs what the user sees (the edit diff); tool calls run in parallel by default; tools declared in the transcript; how this differs from Codex's tools | [03](../educodex/03-tool-calling.md), [07](../educodex/07-built-in-tools.md) |
| 06 | [Sessions](06-sessions.md) | pi's session file: a tree of entries with `id` and `parentId`; the context rebuilt from the entries; `new_session` and `get_messages`; how it differs from Codex's rollout files | [16](../educodex/16-session-logs.md) |
| 07 | [Compaction](07-compaction.md) | pi's three triggers (manual, threshold, overflow); the cut point and split turns; the checkpoint and update prompts; the compaction entry and the request rebuilt from it | [15](../educodex/15-compaction.md) |
| 08 | [The RPC protocol](08-rpc-protocol.md) | `pi --mode rpc`: commands, responses and events as JSON lines; how they differ from Codex's App Server | [18](../educodex/18-app-server.md) |

Planned chapters, written with their features: 02 the loop and the queues, 03 prompt assembly, 05 skills.
