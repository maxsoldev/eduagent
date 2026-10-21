# 05 — Skills

Read [educodex chapter 14, Skills](../educodex/14-skills.md) first. It explains what a skill is, the `SKILL.md` frontmatter, and progressive disclosure: only the name, description and path go into the prompt, and the model reads the file when it needs it. pi works the same way. This chapter shows where pi looks for skills, the exact list it puts in its system prompt, and the skills that only the user can call.

## Concept

### Where pi looks

pi scans two folders (in priority order, the first one wins a name collision):

| Folder | Scope | When |
|---|---|---|
| `<cwd>/.pi/skills/` | project | always in edupi (pi: only if the project is trusted; see "Where edupi is simpler") |
| `~/.pi/agent/skills/` (edupi: `~/.eduagent/.edupi/agent/skills/`) | user | always |

In a folder, a sub-folder with a `SKILL.md` is one skill; pi takes that file and does not look deeper. Other sub-folders are searched for more `SKILL.md` files. Plain `.md` files directly in the skills folder are skills too, if their frontmatter has a description. Dot folders and `node_modules` are skipped.

pi scans **once, when the session starts**, not before every prompt. A skill you add later shows up in the next session.

### SKILL.md

```markdown
---
name: greet
description: Greets the user warmly. Use when the user says hello.
disable-model-invocation: false
---

Say hello and name the skill.
```

- `name` falls back to the folder name. A name that is not lowercase `a-z`, `0-9` and hyphens, or longer than 64 characters, gives a warning, but the skill still loads.
- `description` is required (at most 1024 characters). A `SKILL.md` without one is **not loaded**, with the warning `description is required`.
- `disable-model-invocation: true` hides the skill from the model (see below).
- Two skills with the same name: the first one wins; the other gets a `collision` warning.

### The available-skills list

pi adds a `skills` section to its system prompt (chapter 03), after AGENTS.md and before the cwd:

```
<skills>
The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>greet</name>
    <description>Greets the user warmly. Use when the user says hello.</description>
    <location>/home/me/repo/.pi/skills/greet/SKILL.md</location>
  </skill>
</available_skills>
</skills>
```

This is the XML format of the [Agent Skills](https://agentskills.io/integrate-skills) standard. Values are XML-escaped (`&amp;`, `&lt;`, `&apos;` ...). There is no size budget: every skill is listed. The section is there only if the model has a `read` or `bash` tool; with only `bash`, the second line says "Use bash to load a skill's file ...".

### The lazy load: the model reads the file

When a task matches a description, the model calls pi's `read` tool on the `<location>`. The body comes back as a normal tool result:

```
tool_execution_start  read {"path": "/home/me/repo/.pi/skills/greet/SKILL.md"}
tool_execution_end    "---\nname: greet\n...\nSay hello and name the skill.\n"
message_end toolResult
```

So the harness does nothing special. The skill's text enters the context only in the request after the read, as a `tool` message. If `SKILL.md` names other files (`references/api.md`), the model reads them the same way, relative to the skill's folder.

### Skills the user calls: /skill:name

The user can also call a skill directly. `/skill:release v1.2` is expanded by the session before the run starts. The skill's body (without frontmatter) replaces the command, and the rest of the line follows:

```
<skill name="release" location="/home/me/.pi/agent/skills/release/SKILL.md">
References are relative to /home/me/.pi/agent/skills/release.

Tag and push.
</skill>

v1.2
```

This text is the user message, as the model and the session file see it. An unknown name is sent unchanged. The RPC command `get_commands` lists every skill as a command `skill:<name>`, with `source: "skill"` and its `sourceInfo`: the file `path`, `source: "auto"` (found in a skills folder), the `scope` (`user` or `project`) and the `baseDir` of that folder's owner (the agent folder, or `<cwd>/.pi`).

A skill with `disable-model-invocation: true` is **not in the list** the model sees, so the model never loads it. It is still in `get_commands`, and `/skill:name` still works. Use this for skills with side effects, such as a release, that should run only when a person asks.

## In edupi

| File | Mirrors (pi) | What it does |
|---|---|---|
| [`src/coding-agent/core/skills.ts`](../../../backends/edupi/src/coding-agent/core/skills.ts) | `coding-agent/src/core/skills.ts` | `loadSkillsFromDirInternal`, `loadSkillFromFile` (frontmatter, validation, source info), `loadSkills` (collisions), `formatSkillsForPrompt` |
| [`src/coding-agent/utils/frontmatter.ts`](../../../backends/edupi/src/coding-agent/utils/frontmatter.ts) | `coding-agent/src/utils/frontmatter.ts` | YAML frontmatter with pi's `yaml` package |
| [`src/coding-agent/core/resource-loader.ts`](../../../backends/edupi/src/coding-agent/core/resource-loader.ts) | `coding-agent/src/core/resource-loader.ts`, `package-manager.ts` | `DefaultResourceLoader.reload()`: the skill folders in pi's order, then `loadSkills` |
| [`src/coding-agent/core/agent-session.ts`](../../../backends/edupi/src/coding-agent/core/agent-session.ts) | `coding-agent/src/core/agent-session.ts` | `_expandSkillCommand` (`/skill:name`) |
| [`src/coding-agent/modes/rpc/rpc-mode.ts`](../../../backends/edupi/src/coding-agent/modes/rpc/rpc-mode.ts) | `modes/rpc/rpc-mode.ts` | `get_commands` |

The opt-out is one filter, at the start of the list:

```ts
export function formatSkillsForPrompt(skills: Skill[], fileReadTool: "read" | "bash" = "read"): string {
  const visibleSkills = skills.filter((s) => !s.disableModelInvocation);
  if (visibleSkills.length === 0) return "";
  ...
```

**Teaching extras.** When the first prompt of a session is assembled, the session calls the probe hook `skillsLoaded`, and the tracer sends the shared trace event `skillsLoaded` (`protocol/README.md` section 6): the scanned `roots` with their scope, each skill (`name`, `description`, `path`, `scope`, `disableModelInvocation`), and the warnings as `errors`. pi loads the skills when the session starts; edupi reports them with the first prompt, when the viewer listens. In the viewer, the `$` list in the composer comes from `get_commands`; picking a skill sends `/skill:<name> <your text>`. In the **Context** tab, a tool output that read a `SKILL.md` is labelled `tool output: SKILL.md`.

The tests in [`test/rpc-system-prompt.test.ts`](../../../backends/edupi/test/rpc-system-prompt.test.ts) check the list in the request body for skills in both folders, a name collision, an opted-out skill and a skill without description; a scripted read of a `SKILL.md` (the lazy load); `get_commands` and `/skill:name`. [`test/launcher-entry.test.ts`](../../../backends/edupi/test/launcher-entry.test.ts) starts the shipped launcher entry and checks that it lists a project skill.

## In pi

- Loading: [`loadSkillsFromDir`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/skills.ts#L168), [`loadSkillFromFile`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/skills.ts#L277), [`validateName`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/skills.ts#L92), [`validateDescription`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/skills.ts#L117), [`loadSkills`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/skills.ts#L414).
- The list: [`formatSkillsForPrompt`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/skills.ts#L358), and where the prompt adds it: [`buildSystemPromptSections`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/system-prompt.ts#L128).
- The folders: [`addAutoDiscoveredResources`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/package-manager.ts#L2419).
- Commands: [`_expandSkillCommand`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/agent-session.ts#L2177), [`get_commands`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L680).

## How Codex does it differently

| | pi | Codex |
|---|---|---|
| Folders | `<cwd>/.pi/skills` (pi: trusted projects only), `~/.pi/agent/skills` | `.agents/skills` from the git root to cwd, the project's `.codex/skills`, `~/.agents/skills`, `~/.codex/skills`, and system skills shipped in the binary |
| Project files | pi: need project trust, and RPC mode does not trust a new project; edupi: always read | an untrusted project's `config.toml` is ignored, but its skills are still listed ([test](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/ext/skills/src/host_roots_tests.rs#L244)); the sandbox and approvals guard what the model does with them |
| When scanned | once per session | before every turn |
| The list | a `<skills>` section of the system prompt, every skill | a developer message `<skills_instructions>`, cut to a budget (2% of the context window) |
| How the model loads one | the `read` tool on `<location>` | a shell command (`cat .../SKILL.md`) through `exec_command` |
| The user calls one | `/skill:name args`: the body **replaces** the user's text, in a `<skill>` block | `$name` in the message: the harness adds a separate `<skill>` message next to the user's text |
| Hidden from the model | `disable-model-invocation: true` in the `SKILL.md` frontmatter | `policy.allow_implicit_invocation: false` in the skill's `agents/openai.yaml` ([`allows_implicit_invocation`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/skills/src/model.rs#L23)) |

The idea is the same in both: names and descriptions up front, the file on demand. pi keeps it smaller. Its list is part of the one system prompt, the model reads the file with its file tool, and (in pi) the project folder is guarded by trust instead of by a sandbox. Codex scans every turn, budgets the list, and merges more folders, including the `.agents/skills` folders that other agents share.

The Codex side: [skill roots](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/ext/skills/src/host_roots.rs#L48), [the catalog text](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/ext/skills/src/catalog_prompt.rs#L4), [the budget](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/ext/skills/src/render.rs#L19), [`$name` mentions](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/skills/src/mentions.rs#L84). educodex's version is in [chapter 14](../educodex/14-skills.md).

## Where edupi is simpler

- **Two folders only.** pi also scans the `.agents/skills` folders (in trusted projects, from cwd up to the git root) and `~/.agents/skills`, and takes skills from packages, settings and `--skill` paths. edupi scans `<cwd>/.pi/skills` and its home's `skills` folder, so it never reads the folders of other agents.
- **No ignore files.** pi skips paths listed in `.gitignore`, `.ignore` and `.fdignore` inside a skills folder. edupi does not.
- **No project trust: project skills always load.** pi reads files in `<cwd>/.pi` (skills, `SYSTEM.md`, settings, extensions) only from a trusted project, because anyone who can write to a repo can put instructions there. The decision: `--approve`/`--no-approve`, then "nothing to trust", then a saved answer in `~/.pi/agent/trust.json`, else pi asks; RPC mode cannot ask, so a new project is not trusted ([`resolveProjectTrusted`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/project-trust.ts#L47), [project skills only when trusted](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/package-manager.ts#L2494)). edupi has no trust check, no flags and no `trust.json`: you pick the folder in the launcher yourself. AGENTS.md needs no trust in pi either.
- **No symlinks, no unreadable files.** pi follows symlinked skill folders, loads a file reached twice through a symlink once, and turns an unreadable or broken `SKILL.md` into a warning. edupi skips symlinks and stops on a broken file.
- **No `/reload`.** Skills are read when a session starts.
- **No `enableSkillCommands` setting** and no errors reported to extensions when a `/skill:` file cannot be read: edupi sends the text as typed.

## Try it

Make a skill in edupi's home and one in a project:

```bash
mkdir -p ~/.eduagent/.edupi/agent/skills/haiku
printf -- '---\nname: haiku\ndescription: Answer as a haiku. Use when the user asks for a poem.\n---\n\nWrite exactly three lines: 5, 7 and 5 syllables.\n' \
  > ~/.eduagent/.edupi/agent/skills/haiku/SKILL.md
mkdir -p /tmp/edupi-skills/.pi/skills/release
printf -- '---\nname: release\ndescription: Cut a release.\ndisable-model-invocation: true\n---\n\nPrint the steps to tag and push a release.\n' \
  > /tmp/edupi-skills/.pi/skills/release/SKILL.md
```

Open **edupi** in the visualiser in `/tmp/edupi-skills` and ask *"Write me a poem about rain."* In the **Timeline**, **Skills loaded** shows both skills. The model calls `read` on `haiku/SKILL.md`, then answers. The **Context** tab shows the `skills` part of the system prompt (`haiku` only: `release` opts out) and the `tool output: SKILL.md`. Type `$` in the composer: `release` is in the list. Pick it and send: the user message is the skill's body in a `<skill>` block.

Compare with educodex: put the same `haiku` folder in `~/.agents/skills` and ask the same question. Codex lists it in a developer message and reads it with `exec_command`.

Run the tests:

```bash
npx vitest run test/rpc-system-prompt.test.ts
```

## Further reading

- pi's [`docs/skills.md`](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/docs/skills.md), and [`docs/security.md`, "Understand project trust"](https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/docs/security.md#L27) (the trust rule edupi leaves out).
- [Agent Skills](https://agentskills.io/): the open format, and [how a harness lists skills](https://agentskills.io/integrate-skills).
- Anthropic, [Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills): progressive disclosure.
- [educodex chapter 14](../educodex/14-skills.md): Codex's skills in detail.
