// Seam A on the shipped launcher entry (launcher/backends.json): edupi started with that exact
// command, in a directory the student picked, loads the project's own skills (<cwd>/.pi/skills).
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { type Message, RpcClient } from "./rpc-client.ts";

const REPO = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
const entry = JSON.parse(readFileSync(join(REPO, "launcher", "backends.json"), "utf8")).backends.find(
	(b: Message) => b.name === "edupi",
);

let edupi: RpcClient;
afterEach(async () => {
	await edupi?.close();
});

test("the shipped edupi entry loads the project skills of the chosen directory", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "edupi-test-")));
	const skill = join(dir, "project", ".pi", "skills", "greet");
	mkdirSync(skill, { recursive: true });
	writeFileSync(join(skill, "SKILL.md"), "---\nname: greet\ndescription: Greets the user.\n---\n\nSay hi.\n");
	// biome-ignore lint/suspicious/noTemplateCurlyInString: "${REPO}" is the launcher's placeholder, not a template
	const [program, ...args] = entry.command.map((part: string) => part.replaceAll("${REPO}", REPO));
	const env = { ...process.env, OPENROUTER_API_KEY: "", EDUPI_CODING_AGENT_DIR: join(dir, "home", "agent") };
	// --offline: no OpenRouter model list in tests.
	const proc = spawn(program === "node" ? process.execPath : program, [...args, "--offline"], {
		cwd: join(dir, "project"),
		env,
	});
	edupi = new RpcClient(proc, dir);

	const { data } = await edupi.command("get_commands");
	expect(data.commands.map((c: Message) => [c.name, c.sourceInfo.scope])).toEqual([["skill:greet", "project"]]);
});
