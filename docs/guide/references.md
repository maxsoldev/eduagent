# References

External reading for the guide, grouped by topic. Each chapter links the relevant items again.

## Codex, from the team that builds it
- [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/) — Michael Bolin, OpenAI, Jan 2026. Prompt layout, stateless requests, prompt caching, compaction. **Read this first.**
- [Unlocking the Codex harness: how we built the App Server](https://openai.com/index/unlocking-the-codex-harness/) — Celia Chen, OpenAI, Feb 2026. Why JSON-RPC, the thread/turn/item primitives, server-initiated approvals.
- [Harness engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/) — OpenAI, Feb 2026.
- [Building a safe, effective sandbox to enable Codex on Windows](https://openai.com/index/building-codex-windows-sandbox/) — OpenAI, May 2026. Good background on what an OS sandbox must enforce.
- [The New Inner Loop of Software Engineering](https://turingpost.substack.com/p/the-new-inner-loop-of-software-engineering) — interview with Michael Bolin. Sandboxing on each OS, harness vs model.

## Codex documentation
- [Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security) — sandbox modes and approval policies from the user's side.
- [Sandboxing](https://developers.openai.com/codex/concepts/sandboxing) and [Auto-review](https://developers.openai.com/codex/concepts/sandboxing/auto-review).
- [Custom instructions with AGENTS.md](https://developers.openai.com/codex/guides/agents-md) — discovery and merge order.
- [Configuration reference](https://developers.openai.com/codex/config-reference).
- Codex source at the pinned commit: [`codex-rs/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs).

## What a harness is
- [The Anatomy of an Agent Harness](https://www.langchain.com/blog/the-anatomy-of-an-agent-harness) — Vivek Trivedy, LangChain, Mar 2026. "Agent = Model + Harness."
- [Components of a Coding Agent](https://magazine.sebastianraschka.com/p/components-of-a-coding-agent) — Sebastian Raschka, Apr 2026.
- [Building effective agents](https://www.anthropic.com/research/building-effective-agents) — Anthropic, Dec 2024. Workflows vs agents; start simple.
- [Designing agentic loops](https://simonw.substack.com/p/designing-agentic-loops) — Simon Willison, Oct 2025.

## Build one yourself
- [How to Build an Agent](https://ampcode.com/how-to-build-an-agent) — Thorsten Ball. A working agent in a few hundred lines.
- [Around the Loop: Building a Coding Agent Harness in Python](https://eddmann.com/posts/around-the-loop-building-a-coding-agent-harness-in-python/) — Edd Mann, Apr 2026.
- [Build Your Own Coding Agent](https://www.byoharness.dev/chapters/01-the-agent-loop.html) — a book-length walkthrough (Go).

## Context engineering
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) — Anthropic, 2025.
- [Context Engineering for AI Agents: Lessons from Building Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) — Manus, Jul 2025. KV-cache hit rate, keeping errors in context, todo recitation.
- [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) — Anthropic.

## Tools
- [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) — Anthropic, 2025.
- [Edit formats](https://aider.chat/docs/more/edit-formats.html) — Aider. Why the shape of the edit tool changes results.
- [Function calling guide](https://platform.openai.com/docs/guides/function-calling) — OpenAI. Includes custom (freeform) tools.

## APIs and protocols
- [OpenRouter Responses API](https://openrouter.ai/docs/api_reference/responses/overview) — the endpoint educodex uses.
- [Prompt caching](https://platform.openai.com/docs/guides/prompt-caching) — OpenAI.
- [Model Context Protocol specification](https://modelcontextprotocol.io/specification/latest).
- [JSON-RPC 2.0 specification](https://www.jsonrpc.org/specification) — what Codex's "JSON-RPC lite" simplifies.

## Security
- [The lethal trifecta for AI agents](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) — Simon Willison. Private data + untrusted content + external communication.
