# 14 — Skills

## Concept

### Instructions you pay for only when you use them

`AGENTS.md` (chapter 05) goes into every request. That is fine for "run tests with `uv run pytest`". It is too expensive for "how we write a database migration, step by step, with three helper scripts". Most turns do not need it, and ten such guides would fill the context.

A **skill** is a folder of instructions for one kind of task:

```
deploy/
├── SKILL.md          required: frontmatter + instructions
├── scripts/          optional: code the agent can run instead of retyping it
├── references/       optional: longer docs that SKILL.md points to
└── assets/           optional: templates, images
```

`SKILL.md` starts with YAML frontmatter:

```markdown
---
name: deploy
description: Deploy the web app to staging or production. Use when the user asks to ship or release.
---

# Deploy
1. Run `scripts/check.sh` …
```

The harness puts only the **name, description and path** of each skill into the prompt. That is the **catalog**. The model reads the full `SKILL.md` with its normal shell tool when a task matches the description. If `SKILL.md` says "for Postgres, read `references/postgres.md`", the model reads that file next. This is **progressive disclosure**: the cost of a skill in context grows only as far as the task needs it.

So the description does the most important work. It must say *when* to use the skill, because that is all the model sees until it decides to open the file.

### Two ways a skill gets used

| | Who decides | What the harness does |
|---|---|---|
| **Implicit** | The model: the task matches a description in the catalog | Nothing. The model runs `cat …/SKILL.md` itself |
| **Explicit** | The user: they write `$deploy` in the message, or pick the skill from a list | Reads the whole `SKILL.md` and adds it to the turn as a `<skill>` message |

The explicit path saves a tool call and removes doubt: the user asked for this skill, so its full text is in context before the model starts.

### Where skills come from

Skills live in **roots**, folders the harness scans:

| Root | Scope | Typical use |
|---|---|---|
| `.agents/skills/` in the project (any folder from the git root down to cwd) | repo | Shared with the team in git |
| `~/.agents/skills/` | user | Your own skills, in every project |
| `<home>/skills/` | user | The older Codex location (Codex marks it deprecated) |
| `<home>/skills/.system/` | system | Skills that ship with the harness |

`<home>` is `~/.codex` in Codex and `~/.eduagent/.educodex` in educodex. `.agents/skills` is a convention shared by several agents, so one skill folder can work with Codex, Claude Code and others.

## In educodex

The code is in [`core/skills/`](../../../backends/educodex/src/educodex/core/skills/), four small modules:

| Module | What it does | Codex |
|---|---|---|
| [`loader.py`](../../../backends/educodex/src/educodex/core/skills/loader.py) | Roots, scan, frontmatter | `ext/skills/src/host_roots.rs`, `loader/`, `skills/src/parser.rs` |
| [`system.py`](../../../backends/educodex/src/educodex/core/skills/system.py) | Install bundled skills into `<home>/skills/.system` | `skills/src/lib.rs` |
| [`render.py`](../../../backends/educodex/src/educodex/core/skills/render.py) | The catalog and the `<skill>` message | `ext/skills/src/catalog_prompt.rs`, `render.rs`, `fragments.rs` |
| [`mentions.py`](../../../backends/educodex/src/educodex/core/skills/mentions.py) | `$name` → which skills to inject | `skills/src/mentions.rs`, `selection.rs` |

### 1. Scanning

[`load_skills`](../../../backends/educodex/src/educodex/core/skills/loader.py#L143) runs at the start of **every turn** (in [`run_turn`](../../../backends/educodex/src/educodex/core/turn.py)), so a skill you add mid-conversation shows up on the next message. For each root, [`find_skill_files`](../../../backends/educodex/src/educodex/core/skills/loader.py#L88) walks up to 6 folders deep, skips hidden folders (that is why `.system` inside `<home>/skills` is not scanned twice), and collects every `SKILL.md`.

[`parse_skill_frontmatter`](../../../backends/educodex/src/educodex/core/skills/loader.py#L113) applies Codex's rules:
- the file must start with a `---` line and have a closing `---`;
- `name` defaults to the folder name and may have at most 64 characters;
- `description` is required;
- line breaks in values become single spaces, so each value is one line in the catalog.

A broken skill does not stop the turn. It becomes an error entry (`"missing field `description`"`), which `skills/list` returns and the Timeline shows in `trace/skillsLoaded`.

Two skills can have the same name if they live in different roots. Both stay in the catalog. Only `$name` cannot pick one, so it picks neither (see step 4).

### 2. Bundled skills

[`install_system_skills`](../../../backends/educodex/src/educodex/core/skills/system.py#L27) copies `vendor/codex/skills/` to `<home>/skills/.system/` when a session starts. A marker file holds a SHA-256 of the bundled files, so the copy is only rewritten when they change. educodex bundles one of Codex's five system skills, **skill-creator**, which teaches the agent to write new skills. Turn it off with `Config(bundled_skills=False)`.

### 3. The catalog

[`render_available_skills`](../../../backends/educodex/src/educodex/core/skills/render.py#L50) builds a developer fragment. With a repo skill and the bundled one, the model sees:

```
<skills_instructions>
## Skills
A skill is a set of local instructions to follow that is stored in a `SKILL.md` file. Below is the list of skills that can be used. Each entry includes a name, description, and a short path that can be expanded into an absolute path using the skill roots table.
### Skill roots
- `r0` = `/Users/me/.educodex/skills/.system`
- `r1` = `/Users/me/project/.agents/skills`
### Available skills
- skill-creator: Create or update a Codex skill with appropriately scoped instructions and any needed supporting resources. (file: r0/skill-creator/SKILL.md)
- deploy: Deploy the web app to staging or production. Use when the user asks to ship or release. (file: r1/deploy/SKILL.md)
</skills_instructions>
```

Things to notice:
- **Root aliases.** `r0`, `r1` stand for long folder paths. Each path is written once, not once per skill.
- **Order.** System skills first, then repo, then user, each sorted by name, as Codex's host catalog does.
- **Placement.** [`build_fragments`](../../../backends/educodex/src/educodex/core/context/world_state.py#L40) puts the catalog in the developer bundle, *just before* `<permissions instructions>`. Codex does the same with a special case in its world state ([`mod.rs#L474`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/context/world_state/mod.rs#L474)).
- **Prompt cache.** The catalog is a normal world-state fragment (chapter 05). If no skill changed, the next turn does not repeat it. Add a skill, and the next turn appends a new catalog message.
- **"How to use skills".** Codex can append a long section with trigger rules and progressive-disclosure steps. The catalog decides this per model (`include_skills_usage_instructions` in `models.json`). Today only `gpt-5.5` has it on, so `gpt-6-luna` gets the short form above.

### 4. `$name` mentions

[`collect_explicit_skill_mentions`](../../../backends/educodex/src/educodex/core/skills/mentions.py#L38) decides which skills the user asked for. It checks three things, in Codex's order:

1. **`{"type": "skill", "name", "path"}` input items.** A client sends one when you pick a skill from its `$` list (see below). The path decides, so two skills with the same name are not a problem.
2. **Links** like `[$deploy](/path/to/deploy/SKILL.md)` in the text, matched by path.
3. **Plain `$deploy`**, matched only if *exactly one* skill has that name. `$PATH`, `$HOME` and other common environment variables never count.

For each selected skill, [`record_skill_injections`](../../../backends/educodex/src/educodex/core/turn.py#L202) adds a user message right after the user's own message:

```
<skill>
<name>deploy</name>
<path>/Users/me/project/.agents/skills/deploy/SKILL.md</path>
---
name: deploy
description: Deploy the web app …
---

# Deploy
1. Run `scripts/check.sh` …
</skill>
```

It is a `user` message, not `developer`: a skill is content from the user's world, like `AGENTS.md`. Compaction treats it as injected context, not as something the user typed ([`compact.py`](../../../backends/educodex/src/educodex/core/compact.py)).

### 5. Clients: the `$` list and `skills/list`

The web UI and the TUI list skills when you type `$`, like Codex's TUI. They get the list from the app-server method `skills/list` (same name and shape as Codex):

```json
{"id": 7, "method": "skills/list", "params": {"cwds": ["/Users/me/project"]}}
{"id": 7, "result": {"data": [{"cwd": "/Users/me/project", "errors": [],
  "skills": [{"name": "deploy", "description": "Deploy the web app …", "path": "/Users/me/project/.agents/skills/deploy/SKILL.md",
              "scope": "repo", "enabled": true, "pluginId": null}]}]}}
```

When you pick a skill, the web UI inserts `$deploy` into the text and sends a skill input item with the path next to the text, as Codex's TUI does. `/skills` prints the list into the chat.

## In Codex

| What | Where in Codex |
|---|---|
| Skill roots (config layers, `~/.agents/skills`, repo `.agents/skills`) | [`ext/skills/src/host_roots.rs#L48`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/ext/skills/src/host_roots.rs#L48), [`#L137`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/ext/skills/src/host_roots.rs#L137) |
| Scan limits (depth 6, 2000 folders), file names | [`ext/skills/src/loader/mod.rs#L19`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/ext/skills/src/loader/mod.rs#L19) |
| Frontmatter parsing and validation | [`skills/src/parser.rs#L44`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/skills/src/parser.rs#L44) |
| Merge: dedupe by path, order by scope | [`ext/skills/src/loader/host_merge.rs#L198`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/ext/skills/src/loader/host_merge.rs#L198) |
| System skills embedded in the binary and installed with a marker | [`skills/src/lib.rs#L77`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/skills/src/lib.rs#L77), [`assets/samples/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/skills/src/assets/samples) |
| Catalog text (intro, "How to use skills") | [`ext/skills/src/catalog_prompt.rs#L4`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/ext/skills/src/catalog_prompt.rs#L4), [`#L81`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/ext/skills/src/catalog_prompt.rs#L81) |
| Catalog budget (2% of the context window, 8,000 characters without one) | [`ext/skills/src/render.rs#L19`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/ext/skills/src/render.rs#L19) |
| `<skills_instructions>` and `<skill>` fragments | [`ext/skills/src/fragments.rs#L39`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/ext/skills/src/fragments.rs#L39), [`#L76`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/ext/skills/src/fragments.rs#L76) |
| `$name` extraction, ignored environment variables | [`skills/src/mentions.rs#L84`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/skills/src/mentions.rs#L84), [`#L208`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/skills/src/mentions.rs#L208) |
| Selection: skill items, links, unique plain names | [`skills/src/selection.rs#L44`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/skills/src/selection.rs#L44) |
| Where the turn collects mentions | [`core/src/session/turn.rs#L1081`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/turn.rs#L1081) |
| `[skills]` in `config.toml` | [`config/src/skills_config.rs#L41`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/config/src/skills_config.rs#L41) |
| `skills/list` | [`app-server-protocol/src/protocol/common.rs#L881`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/protocol/common.rs#L881) |
| The TUI's `$` list | [`tui/src/bottom_pane/skill_popup.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/tui/src/bottom_pane/skill_popup.rs) |

Codex also reads an optional `agents/openai.yaml` next to `SKILL.md`. It holds a display name, icons and a default prompt for UIs, MCP servers the skill needs, and `allow_implicit_invocation: false` to keep a skill out of the catalog (only `$name` can use it then).

## Where educodex is simpler

| Codex | educodex |
|---|---|
| Catalog budget: 2% of the context window. Too many skills → shorter descriptions, then dropped skills, plus a warning | No budget: every skill gets its full description (cut at 1,024 characters) |
| Aliased paths only when they are shorter than full paths | Always aliased |
| Skill snapshots cached per cwd, a file watcher, `skills/changed` notifications | A fresh scan on every turn and every `skills/list` |
| `[[skills.config]]` to turn single skills off; `skills/config/write` | All found skills are on. Only the whole catalog can be turned off (`include_skill_instructions`) |
| `agents/openai.yaml`: UI metadata, MCP dependencies, implicit-invocation policy | Not read |
| Admin root `/etc/codex/skills`, project `.codex/skills`, plugin skills (`plugin:skill`), cloud and executor skills with `skills.list`/`skills.read` tools | Repo `.agents/skills`, user and system roots only |
| A YAML repair pass for values like `description: Build for AWS: ECS` | Plain YAML: quote such values |
| Five bundled skills | One (`skill-creator`) |
| Telemetry for injected and implicitly used skills | `trace/skillsLoaded`, `trace/skillInjected` |

## Try it

1. Make a project with one skill:

   ```bash
   mkdir -p /tmp/skills-demo/.agents/skills/haiku && cd /tmp/skills-demo && git init -q
   cat > .agents/skills/haiku/SKILL.md <<'EOF'
   ---
   name: haiku
   description: Write a haiku about the project. Use when the user asks for a poem.
   ---
   Write one haiku (5-7-5) to haiku.txt. End your reply with the line HAIKU-SKILL-USED.
   EOF
   ```

2. Use it explicitly:

   ```bash
   uv run educodex exec --cwd /tmp/skills-demo "Please use \$haiku"
   ```

   The output shows `skills` in the prompt assembly and a `skill $haiku injected` line. The reply ends with `HAIKU-SKILL-USED`.

3. Use it implicitly: run it again with `"Write me a poem about this project"` and no `$`. Now there is no injection. Watch for a tool call that reads `.agents/skills/haiku/SKILL.md`: the model found the skill in the catalog.

4. In the web UI ([start the launcher](README.md#the-web-ui) and pick **educodex** with the directory `/tmp/skills-demo`), type `$` in the message box. The list shows `$haiku` (repo) and `$skill-creator` (system). In **Context**, the developer message is labelled `developer: skills + permissions + collaboration mode`. Expand it to see the catalog.

5. Ask for a new skill: `"Use $skill-creator to make a skill that formats commit messages"`. Then type `$` again: the new skill is in the list, because skills are scanned on every turn.

## Further reading
- [Codex skills](https://developers.openai.com/codex/skills): writing skills, where Codex looks for them, `$` mentions.
- [Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills): the design, and why progressive disclosure works.
- [Agent Skills specification](https://agentskills.io/): the shared `SKILL.md` format.
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents): just-in-time context, the idea behind skills.
