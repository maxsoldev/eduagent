# 03 — Prompt assembly

Read [educodex chapter 05, Assembling the prompt](../educodex/05-assembling-the-prompt.md) first. It explains why the model sees more than your message, and how Codex builds that context from fragments. This chapter shows how pi does the same job: one system prompt made of named sections, AGENTS.md files inside it, and changes written into the transcript.

## Concept

### One system prompt, in named sections

pi sends one system prompt. It is built from **sections**, always in this order:

| Section | Content | When |
|---|---|---|
| `preamble` | "You are an expert coding assistant operating inside pi, a coding agent harness. ..." | always (a `SYSTEM.md` file replaces it) |
| `tools` | one line per tool: `- read: Read file contents` | always (not with `SYSTEM.md`) |
| `rules` | `- Use bash for file operations like ls, rg, find`, each tool's guidelines, then two closing rules | always (not with `SYSTEM.md`) |
| `docs` | where pi's own docs are | real pi only (edupi leaves it out) |
| `addendum` | the text of `APPEND_SYSTEM.md` | if the file exists |
| `project_context` | the AGENTS.md files | if there are any |
| `skills` | the available-skills list (chapter 05) | if there are skills and a `read` or `bash` tool |
| `cwd` | the working directory | always |

The preamble is plain text. Every other section is wrapped in a tag with its own name. The full prompt is the sections joined by blank lines:

```
You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

<tools>
- read: Read file contents
- bash: Execute bash commands (ls, grep, find, etc.)
- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call
- write: Create or overwrite files

In addition to the tools above, you may have access to other custom tools depending on the project.
</tools>

<rules>
- Use bash for file operations like ls, rg, find
- Use read to examine files instead of cat or sed.
...
- Be concise in your responses
- Show file paths clearly when working with files
</rules>

<project_context>
Project-specific instructions and guidelines:

<project_instructions path="/home/me/repo/AGENTS.md">
Run tests with npm test.
</project_instructions>
</project_context>

<cwd>
/home/me/repo
</cwd>
```

There is no date, no shell and no OS in the prompt. The tool lines and the rules come from the tools: each tool has a one-line **snippet** and a list of **guidelines** (chapter 04). Duplicate rules are removed.

### AGENTS.md: from the filesystem root down to cwd

pi looks for one context file per folder. In each folder it takes the first file that exists of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`. It looks in:

1. the home's agent folder (`~/.pi/agent/AGENTS.md`; in edupi `~/.eduagent/.edupi/agent/AGENTS.md`), the **global** file;
2. every folder from cwd up to the filesystem root. pi does not stop at the git root.

The order in the prompt is global first, then from the root down to cwd. So the file nearest to cwd comes last, and the model reads it as the most specific. Each file becomes one `<project_instructions path="...">` block, with its full text. There is no size limit.

AGENTS.md files do not need project trust. Files in the project's `.pi` folder do (chapter 05).

### SYSTEM.md and APPEND_SYSTEM.md

A `SYSTEM.md` file replaces the preamble, the tools list and the rules with its own text. `APPEND_SYSTEM.md` adds an `addendum` section after them. pi reads each from `<cwd>/.pi/` if the project is trusted, else from the home's agent folder. AGENTS.md, skills and cwd stay in both cases.

### The prompt lives in the transcript

pi does not keep the prompt beside the messages. It is a **system message** in the transcript, with the sections in `sections` and an empty `content`. Before each run (`_prepareRun`), pi builds the sections again and compares them with the sections the transcript already has (replayed from all system messages). Only the difference goes into a new system message:

- first prompt of a session: every section is new, so the system message has all of them. The agent loop adds `toolsAdded` to the same message (chapter 04);
- later prompts: usually nothing changed, so no system message is added;
- a reopened session whose prompt changed (another cwd, a new AGENTS.md): a system message with only the changed sections. A removed section is `null`.

```json
{"role": "system", "content": "", "sections": {"docs": null, "skills": null, "cwd": "<cwd>\n/tmp/other\n</cwd>"}, "timestamp": ...}
```

These messages are saved in the session file (chapter 06), so the file says which prompt the model had at each point.

### On the wire: one leading message

OpenRouter's Chat Completions models get the prompt as one message. pi **replays** all system messages of the transcript into one (`getCurrentSystemMessage`: sections patched by name, removed sections dropped) and puts it first (`collapseSystemMessages`). Later system messages are not sent. The role is `developer` for reasoning models that accept it (OpenAI and Anthropic models), else `system`:

```json
"messages": [
  {"role": "system", "content": "You are an expert coding assistant operating inside pi, ...\n\n<cwd>\n/home/me/repo\n</cwd>"},
  {"role": "user", "content": [{"type": "text", "text": "Hello?"}]}
]
```

So a changed section changes the **start** of the next request. That is a cache miss for the whole request. Models that accept system messages in the middle of a conversation get the update in place instead ("Updated system prompt section ..."); edupi's OpenRouter models do not.

## In edupi

| File | Mirrors (pi) | What it does |
|---|---|---|
| [`src/coding-agent/core/system-prompt.ts`](../../../backends/edupi/src/coding-agent/core/system-prompt.ts) | `coding-agent/src/core/system-prompt.ts` | `buildSystemPromptSections`, `buildRules`, `renderProjectContext`, `diffSystemPromptSections` |
| [`src/coding-agent/core/resource-loader.ts`](../../../backends/edupi/src/coding-agent/core/resource-loader.ts) | `coding-agent/src/core/resource-loader.ts` | `loadContextFileFromDir`, `loadProjectContextFiles`, `DefaultResourceLoader` (AGENTS.md, skills, SYSTEM.md, APPEND_SYSTEM.md; read once per session) |
| [`src/coding-agent/core/agent-session.ts`](../../../backends/edupi/src/coding-agent/core/agent-session.ts) | `coding-agent/src/core/agent-session.ts` | `_rebuildSystemPrompt` (gathers the inputs), `_prepareRun` and `_preparePromptAndToolLoadout` (the system message patch before the user message) |
| [`src/coding-agent/core/tools/index.ts`](../../../backends/edupi/src/coding-agent/core/tools/index.ts) | each tool's `promptSnippet`, `promptGuidelines` | `toolSystemPromptContributions`: the tool lines and the rules |
| [`src/ai/utils/transcript.ts`](../../../backends/edupi/src/ai/utils/transcript.ts) | `ai/src/utils/transcript.ts`, `ai/src/utils/text.ts` | `getCurrentSystemMessage`, `collapseSystemMessages`, `getSystemMessageText` |
| [`src/ai/api/openai-completions.ts`](../../../backends/edupi/src/ai/api/openai-completions.ts) | `ai/src/api/openai-completions.ts` | `convertMessages`: the replayed prompt as the first `system` or `developer` message |

The run's starting messages, in edupi's code:

```ts
private _prepareRun(text: string, images: ImageContent[]): AgentMessage[] {
  const messages: AgentMessage[] = [{ role: "user", content: [{ type: "text", text }, ...images], timestamp: Date.now() }];
  const update = this._preparePromptAndToolLoadout(this._baseSystemPromptOptions);
  if (update) messages.unshift(update); // the changed sections go before the user message
  return messages;
}
```

**Teaching extras.** Before each run the session calls the probe hook `promptAssembled`. The tracer sends the shared trace event `promptAssembled` (`protocol/README.md` section 6): one fragment per section with its `kind` (the section name), `source` (pi's code, or the AGENTS.md paths), `text`, `tokens` and `changed` (in this run's patch), plus `firstTurn`. In the viewer, the **Context** tab shows the request's first message as the system prompt, with one part per section. Until edupi has a context command (`debug_` commands, later), the Context tab shows the last request edupi sent.

The tests in [`test/rpc-system-prompt.test.ts`](../../../backends/edupi/test/rpc-system-prompt.test.ts) check the prompt in the request body against real pi's text: without AGENTS.md, with nested AGENTS.md files, with skills, after a second prompt, and the trace events.

## In pi

- The sections: [`buildSystemPromptSections`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/system-prompt.ts#L128), [`buildRules`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/system-prompt.ts#L88), [`renderProjectContext`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/system-prompt.ts#L79), [`diffSystemPromptSections`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/system-prompt.ts#L217).
- AGENTS.md and SYSTEM.md: [`loadContextFileFromDir`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/resource-loader.ts#L184), [`loadProjectContextFiles`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/resource-loader.ts#L232), [`discoverSystemPromptFile`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/resource-loader.ts#L1213), [`discoverAppendSystemPromptFile`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/resource-loader.ts#L1227).
- The session: [`_rebuildSystemPrompt`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/agent-session.ts#L1705), [`_preparePromptAndToolLoadout`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/agent-session.ts#L1743), [`_prepareRun`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/agent-session.ts#L1890).
- The replay: [`getCurrentSystemMessage`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/utils/transcript.ts#L73), [`collapseSystemMessages`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/utils/transcript.ts#L108), [`resolveTranscript`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/utils/transcript.ts#L115), [`getSystemMessageText`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/utils/text.ts#L15), and where Chat Completions calls it: [`convertMessages`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/api/openai-completions.ts#L1203).

## How Codex does it differently

| | pi | Codex |
|---|---|---|
| Base prompt | a short preamble, the tools and the rules, built from the tools | long base instructions per model (about 18,000 characters for `gpt-6-luna`), from the model catalog, in the request's `instructions` |
| Context from the harness | sections of one system prompt | separate messages: a developer bundle (permissions, collaboration mode, skills) and a user bundle (AGENTS.md, environment) |
| AGENTS.md | inside the system prompt, one `<project_instructions>` block per file | a **user** message `# AGENTS.md instructions for <cwd>`, so it cannot outrank the harness's developer rules |
| AGENTS.md search | the global file, then every folder from the **filesystem root** to cwd; also `CLAUDE.md`; no size limit | the home's file, then the folders from the **git root** to cwd; 32 KiB in total |
| Environment | only `<cwd>` | `<environment_context>`: cwd, shell, date, timezone, sandbox |
| A change between turns | a system message with the changed sections; on the wire the prompt is rebuilt at the start | a new message **appended** with the changed fragment; the start of the request never changes |
| Prompt cache | a change rewrites the start of the request: one full miss | append-only: the cached prefix stays valid |
| Where it is kept | in the transcript and the session file, as system messages | in the rollout file, as the context items that were sent |

Both harnesses send only what changed. They differ in where the change goes. Codex appends, so the old text stays in the history and the model reads the newest one as valid. pi patches sections by name and replays them into one prompt, so the model always sees one clean prompt, at the price of the cache.

The Codex side: [`build_initial_context_with_world_state`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/mod.rs#L4212), [`record_context_updates_and_set_reference_context_item`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/mod.rs#L4627), [AGENTS.md discovery](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/agents_md.rs), [the AGENTS.md wrapper](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/context/user_instructions.rs#L24). educodex's version is in [chapter 05](../educodex/05-assembling-the-prompt.md).

## Where edupi is simpler

- **No `<docs>` section.** Real pi lists the paths of its own README, docs and examples. edupi has no such docs, so it leaves the section out. Everything else is pi's text.
- **The resources are read once per session.** pi reads them again on `/reload`; edupi has no reload command. A new session (`new_session`) reads them again.
- **No forced prompt, no hidden tools, no extension sections.** pi's extensions can replace the whole prompt (`before_agent_start`), hide tools from it or add sections. edupi has no extensions.
- **No mid-conversation updates.** edupi's provider always collapses the system messages into one, as pi does for OpenRouter. pi can also send updates in place for providers that accept them.
- **No nested-worktree rule.** pi skips the main repo's AGENTS.md when cwd is in a git worktree nested inside it, so the same file does not appear twice. edupi does not.
- **No PowerShell rules** and no `.agents` folders.

## Try it

In the web UI, open **edupi** and send any message. Open the **Context** tab: the first item is the system prompt. Click it to see its parts, one per section. Then open the **Timeline** and click **Prompt assembled**: each fragment has its source and `changed`. Send a second message: the new `promptAssembled` has no changed fragment, and the Protocol tab shows no new `message_start system`.

Add an AGENTS.md and see where it goes:

```bash
mkdir -p /tmp/edupi-prompt/app && cd /tmp/edupi-prompt
echo "Always answer in French." > AGENTS.md
echo "Use tabs, not spaces." > app/AGENTS.md
```

Open a viewer in `/tmp/edupi-prompt/app` and send a message. The `project_context` part has both files, the outer one first. Compare with educodex in the same folder: there the AGENTS.md text is a separate user message.

Over stdio, with the faux provider (start in `backends/edupi`):

```bash
EDUPI=$PWD; cd /tmp/edupi-prompt/app
node $EDUPI/bin/edupi.mjs --mode rpc --no-session --faux $EDUPI/examples/faux/demo.json --faux-log /tmp/edupi-prompt.jsonl
{"type":"prompt","message":"Hi"}
```

```bash
head -1 /tmp/edupi-prompt.jsonl | jq -r '.body.messages[0].content'
```

Run the tests:

```bash
npx vitest run test/rpc-system-prompt.test.ts
```

## Further reading

- pi's [`docs/configuration.md`, "Context files"](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/docs/configuration.md#L41) and [the project `.pi` folder](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/docs/configuration.md#L26) (SYSTEM.md, APPEND_SYSTEM.md).
- [AGENTS.md](https://agents.md/): the shared format for agent instructions.
- OpenAI, [Prompt caching](https://platform.openai.com/docs/guides/prompt-caching): why the start of a request should not change.
- [educodex chapter 05](../educodex/05-assembling-the-prompt.md): Codex's fragments and its append-only rule.
