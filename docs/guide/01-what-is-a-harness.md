# 01 — What is a harness?

## Concept

### A model only turns text into text

A language model is a function: you send it text (split into *tokens*) and it sends back more text. On its own it cannot:
- read your files,
- run a command,
- remember the previous conversation,
- stop itself from doing something dangerous.

Ask a bare model to "fix the failing test" and the best it can do is *describe* a fix.

### A harness is everything around the model

> **Agent = Model + Harness.** If you're not the model, you're the harness.
> — [The Anatomy of an Agent Harness](https://www.langchain.com/blog/the-anatomy-of-an-agent-harness)

The harness is the program that wraps the model and turns its text into actions. Codex, Claude Code and Cursor are all harnesses. They often use similar models; what differs is the harness.

A coding harness has these jobs:

| Job | Question it answers | Chapter |
|---|---|---|
| **Prompt assembly** | What exactly does the model see? | 05, 06 |
| **Model calls** | How do we send it and read the reply? | 02, 08 |
| **Tools** | What can the model *do*, and how does it ask? | 03, 07, 12 |
| **The loop** | When do we call the model again, and when do we stop? | 04 |
| **Guardrails** | What is the model allowed to do without asking? | 09, 10, 11 |
| **Memory** | What happens when the conversation gets too long, or the app restarts? | 14, 15 |
| **Interface** | How do UIs (terminal, IDE, web) drive the agent? | 16, 17 |

### The core idea in one picture

```
            ┌──────────────────────────────────────────────┐
 user ────► │ harness                                      │
            │   1. build prompt (instructions + history)   │
            │   2. call model ───────────► model           │
            │   3. model replies: ◄──────── "run `ls`"     │
            │   4. check policy, run tool in sandbox       │
            │   5. append tool output to history           │
            │   6. repeat from 2 until model just answers  │
            └──────────────────────────────────────────────┘
                              │
                              ▼
                    final answer + changed files
```

That loop is the **agentic loop**. Chapter 04 builds it. Everything else in this guide is about doing each step well and safely.

### Why look inside a production harness?

Toy agents are a few hundred lines ([example](https://ampcode.com/how-to-build-an-agent)). They work, but they hide the hard questions:
- Why does Codex send the system prompt as a `developer` message?
- Why does it resend the *whole* conversation on every call?
- Why does changing the working directory add a new message instead of editing the old one?
- How does a tool from an MCP server end up in the model's tool list?

The answers come from real constraints: cost, speed, safety and model training. educodex keeps those answers but removes everything that exists only for scale.

## In educodex

educodex follows Codex's structure. Each part is shown in the web UI as it happens:

```
web UI / TUI  ──JSON-RPC──►  app_server  ──events──  core (loop, prompt, tools, policy, sandbox)
                                                       │
                                                       ├─► client  ──HTTP/SSE──► OpenRouter (Responses API)
                                                       └─► mcp     ──stdio────► MCP servers
```

The full module list is in [the design doc](../design.md#module-layout).

## In Codex

Codex is about 2 million lines of Rust in ~160 crates. The parts this guide covers live in a handful of places:

| Part | Where in Codex |
|---|---|
| The loop | [`core/src/session/turn.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/turn.rs#L424) |
| Model calls | [`core/src/client.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/client.rs) |
| Prompt pieces | [`core/src/context/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/context), [`prompts/templates/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/prompts/templates) |
| Model catalog | [`models-manager/models.json`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/models-manager/models.json) |
| Tools | [`core/src/tools/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools) |
| Sandbox | [`sandboxing/src/seatbelt.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/sandboxing/src/seatbelt.rs) |
| MCP | [`codex-mcp/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/codex-mcp) |
| App Server | [`app-server/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server), [`app-server-protocol/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol) |

The rest is product features: the terminal UI, cloud tasks, realtime voice, sub-agents, plugins, Windows and Linux sandboxes, telemetry. Chapter 18 gives a tour.

## Where educodex is simpler

- **About 4,000 lines of Python** instead of millions of lines of Rust. Each module says which Codex file it mirrors in its docstring.
- **One provider.** educodex talks to OpenRouter's Responses API over HTTP. Codex supports several providers, a WebSocket transport and ChatGPT login.
- **macOS sandbox only.** Linux and Windows sandboxes are left out (chapter 10).
- **Extra visibility.** educodex emits `trace/*` events for steps Codex keeps hidden, so the web UI can show them (chapter 17).

Each later chapter lists what it leaves out in this section.

## Try it

`spikes/probe_openrouter.py` is the smallest possible "harness". It sends one prompt with one tool (`apply_patch`), receives a tool call, sends back a fake result and gets a final answer:

```bash
uv run --with httpx spikes/probe_openrouter.py
```

Look at `spikes/out/roundtrip_1.json`. The model did not edit any file. It returned a `custom_tool_call` item, which is text asking the harness to do it. Doing that work is the harness's job.

To see the whole loop without an API key, run educodex against a scripted fake model. It prints every step: prompt assembly, model requests, tool calls, policy decisions. Run it in an empty folder, since the script creates `hello.py`. Near the end it asks you to approve an `rm -rf`:

```bash
mkdir -p /tmp/edu-demo
uv run educodex exec --cwd /tmp/edu-demo --fake-model examples/fake/demo.json "Write a greeting script"
```

## Further reading
- [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/): the best single overview of Codex's harness.
- [The Anatomy of an Agent Harness](https://www.langchain.com/blog/the-anatomy-of-an-agent-harness): derives each harness feature from what models can't do.
- [Components of a Coding Agent](https://magazine.sebastianraschka.com/p/components-of-a-coding-agent): a broader map of the same parts.
- [Building effective agents](https://www.anthropic.com/research/building-effective-agents): when you need an agent at all.
