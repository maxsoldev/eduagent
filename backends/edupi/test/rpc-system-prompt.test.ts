// Seam A: edupi's system prompt, as the faux provider received it in the request body. The
// expected texts come from real pi's requests at the pinned commit (spec4 samples), minus pi's
// <docs> section, which edupi leaves out.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { startEdupi, type Message, type RpcClient } from "./rpc-client.ts";

let edupi: RpcClient;
afterEach(async () => {
	await edupi?.close();
});

async function prompt(message: string) {
	const settled = edupi.seen.filter((m) => m.type === "agent_settled").length;
	edupi.sendLine(JSON.stringify({ type: "prompt", message }));
	await edupi.until(() => edupi.seen.filter((m) => m.type === "agent_settled").length > settled);
}

/** Writes a file, making its folders. */
function put(path: string, text: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

const firstRequest = () => edupi.requests()[0].body.messages as Message[];

// Real pi's prompt text up to its <docs> section (fixtures/pi/session-prompt-and-tools.jsonl).
const BASE = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

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
- You can inspect PI_* environment variables for current model and session details.
- Use edit for precise changes (edits[].oldText must match exactly)
- When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls
- Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.
- Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.
- Use write only for new files or complete rewrites.
- Be concise in your responses
- Show file paths clearly when working with files
</rules>`;

test("without AGENTS.md or skills the prompt is pi's preamble, tools, rules and the working directory", async () => {
	edupi = startEdupi({ responses: ["Hi."] });
	await prompt("Hello?");

	const messages = firstRequest();
	expect(messages[0]).toEqual({ role: "system", content: `${BASE}\n\n<cwd>\n${edupi.dir}\n</cwd>` });
	expect(messages.slice(1)).toEqual([{ role: "user", content: [{ type: "text", text: "Hello?" }] }]);
});

test("AGENTS.md files: the global one first, then one per folder from the root down to cwd", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "edupi-test-")));
	const cwd = join(dir, "repo", "app");
	put(join(dir, "home", "agent", "AGENTS.md"), "Global rule.");
	put(join(dir, "AGENTS.md"), "Outer rule.");
	put(join(dir, "repo", "CLAUDE.md"), "Claude rule."); // a fallback name, used when there is no AGENTS.md
	put(join(dir, "repo", "app", "AGENTS.md"), "App rule.");
	put(join(dir, "repo", "app", "CLAUDE.md"), "Not read: AGENTS.md wins in this folder.");
	edupi = startEdupi({ responses: ["Hi."] }, [], { dir, cwd });
	await prompt("Hello?");

	const file = (path: string, text: string) =>
		`<project_instructions path="${path}">\n${text}\n</project_instructions>`;
	expect(firstRequest()[0].content).toBe(
		`${BASE}\n\n<project_context>\n${[
			"Project-specific instructions and guidelines:",
			file(join(dir, "home", "agent", "AGENTS.md"), "Global rule."),
			file(join(dir, "AGENTS.md"), "Outer rule."),
			file(join(dir, "repo", "CLAUDE.md"), "Claude rule."),
			file(join(cwd, "AGENTS.md"), "App rule."),
		].join("\n\n")}\n</project_context>\n\n<cwd>\n${cwd}\n</cwd>`,
	);
});

/** A SKILL.md with frontmatter. */
const skillFile = (fields: string, body = "Do the steps.") => `---\n${fields}\n---\n\n${body}\n`;

/** Skills in the home (user) and in the project's .pi/skills folder, and one hidden from the model. */
function writeSkills(dir: string) {
	put(
		join(dir, "home", "agent", "skills", "greet", "SKILL.md"),
		skillFile("name: greet\ndescription: Greets the user & says <hi>."),
	);
	put(
		join(dir, "home", "agent", "skills", "release", "SKILL.md"),
		skillFile("name: release\ndescription: Cuts a release.\ndisable-model-invocation: true"),
	);
	put(
		join(dir, "home", "agent", "skills", "deploy", "SKILL.md"),
		skillFile("name: deploy\ndescription: The home's deploy skill (loses to the project's)."),
	);
	put(join(dir, "home", "agent", "skills", "notes", "SKILL.md"), skillFile("name: notes")); // no description: not loaded
	put(join(dir, ".pi", "skills", "deploy", "SKILL.md"), skillFile("name: deploy\ndescription: Deploys this project."));
}

const SKILLS_HEAD = `The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.`;

const skillXml = (name: string, description: string, location: string) =>
	`  <skill>\n    <name>${name}</name>\n    <description>${description}</description>\n    <location>${location}</location>\n  </skill>`;

const skillsSection = (...skills: string[]) =>
	`<skills>\n${SKILLS_HEAD}\n\n<available_skills>\n${skills.join("\n")}\n</available_skills>\n</skills>`;

test("in an untrusted project only the home's skills are listed, by name, description and file; opted-out skills are left out", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "edupi-test-")));
	writeSkills(dir);
	edupi = startEdupi({ responses: ["Hi."] }, [], { dir });
	await prompt("Hello?");

	const home = join(dir, "home", "agent", "skills");
	expect(firstRequest()[0].content).toBe(
		`${BASE}\n\n${skillsSection(
			skillXml(
				"deploy",
				"The home&apos;s deploy skill (loses to the project&apos;s).",
				join(home, "deploy", "SKILL.md"),
			),
			skillXml("greet", "Greets the user &amp; says &lt;hi&gt;.", join(home, "greet", "SKILL.md")),
		)}\n\n<cwd>\n${dir}\n</cwd>`,
	);
});

test("with --approve the project's .pi/skills are loaded too, and win a name collision", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "edupi-test-")));
	writeSkills(dir);
	edupi = startEdupi({ responses: ["Hi."] }, ["--approve"], { dir });
	await prompt("Hello?");

	const home = join(dir, "home", "agent", "skills");
	expect(firstRequest()[0].content).toContain(
		skillsSection(
			skillXml("deploy", "Deploys this project.", join(dir, ".pi", "skills", "deploy", "SKILL.md")),
			skillXml("greet", "Greets the user &amp; says &lt;hi&gt;.", join(home, "greet", "SKILL.md")),
		),
	);
});

test("a trust decision saved in the home's trust.json also trusts the project", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "edupi-test-")));
	writeSkills(dir);
	put(join(dir, "home", "agent", "trust.json"), JSON.stringify({ [dir]: true }));
	edupi = startEdupi({ responses: ["Hi."] }, [], { dir });
	await prompt("Hello?");
	expect(firstRequest()[0].content).toContain("<description>Deploys this project.</description>");
});

test("the prompt is a system message of the transcript: sent once, then replayed at the head of every request", async () => {
	edupi = startEdupi({ responses: ["One.", "Two."] });
	await prompt("First?");
	await prompt("Second?");

	// pi's SystemMessage: empty content, the prompt in named sections, the tools in toolsAdded.
	const systems = edupi.seen
		.filter((m) => m.type === "message_end" && m.message.role === "system")
		.map((m) => m.message);
	expect(systems).toHaveLength(1); // the second prompt did not change it
	expect(systems[0].content).toBe("");
	expect(Object.keys(systems[0].sections)).toEqual(["preamble", "tools", "rules", "cwd"]);
	expect(systems[0].sections.cwd).toBe(`<cwd>\n${edupi.dir}\n</cwd>`);
	expect(systems[0].toolsAdded.map((t: Message) => t.name)).toEqual(["read", "bash", "edit", "write"]);

	const [first, second] = edupi.requests().map((r) => r.body.messages);
	expect(second[0]).toEqual(first[0]);
	expect(second.map((m: Message) => m.role)).toEqual(["system", "user", "assistant", "user"]);
});

const traces = (name: string) => edupi.seen.filter((m) => m.type === "trace" && m.name === name);

test("trace: skillsLoaded lists the scanned folders and skills; promptAssembled names each section, its source and whether it changed", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "edupi-test-")));
	writeSkills(dir);
	put(join(dir, "AGENTS.md"), "Project rule.");
	edupi = startEdupi({ responses: ["One.", "Two."] }, [], { dir });
	await prompt("First?");
	await prompt("Second?");

	const home = join(dir, "home", "agent");
	expect(traces("skillsLoaded")).toHaveLength(1); // pi loads skills once per session, not per prompt
	const loaded = traces("skillsLoaded")[0];
	expect(loaded.projectTrusted).toBe(false); // the project has .pi/skills but no --approve
	expect(loaded.roots).toEqual([{ path: join(home, "skills"), scope: "user" }]);
	expect(loaded.skills.map((s: Message) => [s.name, s.scope, s.disableModelInvocation])).toEqual([
		["deploy", "user", false],
		["greet", "user", false],
		["release", "user", true],
	]);
	expect(loaded.skills[1]).toEqual({
		name: "greet",
		description: "Greets the user & says <hi>.",
		path: join(home, "skills", "greet", "SKILL.md"),
		scope: "user",
		disableModelInvocation: false,
	});
	expect(loaded.errors).toEqual([
		{ path: join(home, "skills", "notes", "SKILL.md"), message: "description is required" },
	]);

	const [first, second] = traces("promptAssembled");
	expect(first.firstTurn).toBe(true);
	expect(first.fragments.map((f: Message) => [f.kind, f.source, f.changed])).toEqual([
		["preamble", "system-prompt.ts", true],
		["tools", "system-prompt.ts + tool snippets", true],
		["rules", "system-prompt.ts + tool guidelines", true],
		["project_context", join(dir, "AGENTS.md"), true],
		["skills", "skills.ts formatSkillsForPrompt", true],
		["cwd", "process cwd", true],
	]);
	const text = first.fragments.map((f: Message) => f.text).join("\n\n");
	expect(text).toBe(edupi.requests()[0].body.messages[0].content); // the fragments are the prompt
	expect(first.fragments[0]).toMatchObject({ role: "system", tokens: Math.ceil(first.fragments[0].text.length / 4) });
	expect(second.firstTurn).toBe(false);
	expect(second.fragments.every((f: Message) => !f.changed)).toBe(true);

	// The trace comes just before the run's messages.
	const at = (m: Message) => edupi.seen.indexOf(m);
	expect(at(loaded)).toBeLessThan(at(first));
	expect(at(first)).toBeLessThan(at(edupi.seen.find((m) => m.type === "agent_start")!));
});

test("lazy skill load: the model reads the SKILL.md from the list with the read tool; only then is its body in the context", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "edupi-test-")));
	writeSkills(dir);
	const path = join(dir, "home", "agent", "skills", "greet", "SKILL.md");
	const read = { type: "toolCall", id: "call_skill", name: "read", arguments: { path } };
	edupi = startEdupi({ responses: [{ content: [read], stopReason: "toolUse" }, "Hello, user!"] }, [], { dir });
	await prompt("Please greet me.");

	const [first, second] = edupi.requests().map((r) => r.body.messages as Message[]);
	expect(first[0].content).toContain(`<location>${path}</location>`); // the list names the file ...
	expect(JSON.stringify(first)).not.toContain("Do the steps."); // ... but its body is not sent

	const start = edupi.seen.find((m) => m.type === "tool_execution_start")!;
	expect(start).toMatchObject({ toolName: "read", args: { path } });
	const end = edupi.seen.find((m) => m.type === "tool_execution_end")!;
	expect(end.result.content[0].text).toContain("description: Greets the user & says <hi>.\n---\n\nDo the steps.");
	expect(second.at(-1)).toEqual({ role: "tool", tool_call_id: "call_skill", content: end.result.content[0].text });
});

test("get_commands lists the skills as /skill:name, and /skill:name sends the skill's body, also for opted-out skills", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "edupi-test-")));
	writeSkills(dir);
	edupi = startEdupi({ responses: ["Released."] }, [], { dir });

	const home = join(dir, "home", "agent", "skills");
	const { commands } = (await edupi.command("get_commands")).data;
	expect(commands.map((c: Message) => c.name)).toEqual(["skill:deploy", "skill:greet", "skill:release"]);
	expect(commands[2]).toEqual({
		name: "skill:release",
		description: "Cuts a release.",
		source: "skill",
		sourceInfo: {
			path: join(home, "release", "SKILL.md"),
			source: "local",
			scope: "user",
			origin: "top-level",
			baseDir: join(home, "release"),
		},
	});

	await prompt("/skill:release v1.2");
	const user = edupi.requests()[0].body.messages[1];
	expect(user.content[0].text).toBe(
		`<skill name="release" location="${join(home, "release", "SKILL.md")}">\nReferences are relative to ${join(home, "release")}.\n\nDo the steps.\n</skill>\n\nv1.2`,
	);
});

test("SYSTEM.md replaces the preamble, tools and rules; APPEND_SYSTEM.md adds an addendum; the project's copies need trust", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "edupi-test-")));
	put(join(dir, "home", "agent", "SYSTEM.md"), "You are the home's assistant.");
	put(join(dir, "home", "agent", "APPEND_SYSTEM.md"), "Answer in French.");
	put(join(dir, ".pi", "SYSTEM.md"), "You are the project's assistant.");
	put(join(dir, "AGENTS.md"), "Project rule.");
	edupi = startEdupi({ responses: ["Bonjour."] }, [], { dir });
	await prompt("Hello?");
	const project = `<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="${join(dir, "AGENTS.md")}">\nProject rule.\n</project_instructions>\n</project_context>`;
	expect(firstRequest()[0].content).toBe(
		`You are the home's assistant.\n\n<addendum>\nAnswer in French.\n</addendum>\n\n${project}\n\n<cwd>\n${dir}\n</cwd>`,
	);
	await edupi.close();

	edupi = startEdupi({ responses: ["Bonjour."] }, ["--approve"], { dir });
	await prompt("Hello?");
	expect(edupi.requests().at(-1)!.body.messages[0].content).toMatch(
		/^You are the project's assistant\.\n\n<addendum>/,
	);
});
