# Harness Engineering with educodex

A guide to how coding agents work under the hood. It goes from "what is an LLM API call" to sandboxing, MCP and compaction. Each chapter explains a concept, shows how educodex implements it, and links to the same thing in the real [OpenAI Codex](https://github.com/openai/codex) source.

No prior knowledge of agents is needed. You should be comfortable reading Python.

## How to read each chapter

Every chapter uses the same blocks:

| Block | Meaning |
|---|---|
| **Concept** | The idea, explained from scratch |
| **In educodex** | Our Python code: the harness in `src/educodex/core/`, teaching extras in `src/educodex/observe/` |
| **In Codex** | The Rust code it mirrors, linked at the pinned commit |
| **Where educodex is simpler** | What we left out or changed, and why |
| **Try it** | Something to run: the CLI, the web UI, or offline with `--fake-model` |
| **Further reading** | Articles, docs, posts |

**Pinned Codex version:** [`1c7c43cd85`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs) (2026-10-07). Codex changes weekly, so links point to this commit and line numbers stay valid.

## Chapters

The milestone column refers to [the design doc](../design.md#milestones). In the web UI, every timeline event links to its chapter.

### Part I — Foundations
| # | Chapter | You will learn | Milestone |
|---|---|---|---|
| 01 | [What is a harness?](01-what-is-a-harness.md) | Model vs harness; what a harness is responsible for; map of Codex | – |
| 02 | [Talking to a model](02-talking-to-a-model.md) | The Responses API: items, roles, streaming (SSE), tokens, context window, stateless requests | 1 |
| 03 | [Tool calling](03-tool-calling.md) | Function tools, JSON Schema, freeform tools with grammars, `call_id` round-trips | 1 |
| 04 | [The agentic loop](04-agentic-loop.md) | Turns vs iterations, when the loop stops, parallel tool calls | 1 |

### Part II — Building the harness
| # | Chapter | You will learn | Milestone |
|---|---|---|---|
| 05 | [Assembling the prompt](05-assembling-the-prompt.md) | Base instructions, developer vs user messages, AGENTS.md, `<environment_context>`, prompt caching and why order matters | 1 |
| 06 | [The model catalog](06-model-catalog.md) | How `models.json` decides prompts, tools and limits per model; code mode and Responses Lite | 1 |
| 07 | [Built-in tools](07-built-in-tools.md) | `exec_command`, `apply_patch`, `update_plan`; tool design; output formatting and truncation | 1 |
| 08 | [Reasoning](08-reasoning.md) | Reasoning items, summaries, `encrypted_content`, why you must send them back | 1 |

### Part III — Guardrails
| # | Chapter | You will learn | Milestone |
|---|---|---|---|
| 09 | [Approvals](09-approvals.md) | Approval policies, who decides, approval requests travelling to the UI | 4 |
| 10 | [Sandboxing](10-sandboxing.md) | OS sandboxes (macOS Seatbelt), sandbox modes, escalation; sandbox vs approval | 4 |
| 11 | [Command policy and prompt injection](11-command-policy-and-prompt-injection.md) | Dangerous-command checks, exec policy rules, the "lethal trifecta" | 4 |

### Part IV — Extending the agent
| # | Chapter | You will learn | Milestone |
|---|---|---|---|
| 12 | [MCP](12-mcp.md) | How external tools reach the model: discovery, naming, schema cleanup, annotations, cache effects | 5 |
| 13 | [Hooks](13-hooks.md) | Running your own code before/after tool calls and at turn end | 6 |
| 14 | [Skills](14-skills.md) | `SKILL.md` folders, the skills catalog, progressive disclosure, `$name` mentions, bundled skills | 8 |

### Part V — Long sessions
| # | Chapter | You will learn | Milestone |
|---|---|---|---|
| 15 | [Context management and compaction](15-compaction.md) | Running out of context; summarising history; local vs remote compaction; `/compact` | 6 |
| 16 | [Session logs](16-session-logs.md) | Rollout JSONL files, resume and replay | 2 |
| 17 | [Memories](17-memories.md) | Learning across threads: the read path, two-phase extraction and consolidation, a sub-agent that edits files | 9 |

### Part VI — Serving the harness
| # | Chapter | You will learn | Milestone |
|---|---|---|---|
| 18 | [The App Server](18-app-server.md) | JSON-RPC lite, thread/turn/item primitives, server-initiated requests | 2 |
| 19 | [Clients and observability](19-clients-and-observability.md) | Building the web UI and TUI on one protocol; slash commands; trace events and the probe seam | 3 |

### Part VII — Beyond educodex
| # | Chapter | You will learn | Milestone |
|---|---|---|---|
| 20 | [What production adds](20-what-production-adds.md) | WebSocket transport, prompt-cache tricks, code mode, sub-agents, auto-review, plugins, multi-provider, evals | – |

## Reading list

See [references.md](references.md) for all external material, grouped by topic.
