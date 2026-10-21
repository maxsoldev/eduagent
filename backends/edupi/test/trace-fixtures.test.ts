// Seam A against the protocol spec: edupi's trace events have the shapes of the fixtures in
// protocol/fixtures/trace/edupi/, and the shared fields of protocol/fixtures/trace/shared.json.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { jsonType, shapeErrors } from "../../../protocol/shape.ts";
import { type Message, type RpcClient, startEdupi } from "./rpc-client.ts";

const FIXTURES = new URL("../../../protocol/fixtures/trace/", import.meta.url);
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`edupi/${name}.json`, FIXTURES), "utf8"));
const shared: Record<string, Record<string, string>> = JSON.parse(
	readFileSync(new URL("shared.json", FIXTURES), "utf8"),
);

let edupi: RpcClient;
afterEach(async () => {
	await edupi?.close();
});

test("edupi's model, loop, tool, prompt, skill, cost and step-mode trace events match the protocol fixtures", async () => {
	const bash = { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "echo hi" } };
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "edupi-test-")));
	const skill = join(dir, "home", "agent", "skills", "greet");
	mkdirSync(skill, { recursive: true });
	writeFileSync(join(skill, "SKILL.md"), "---\nname: greet\ndescription: Greets the user.\n---\n\nSay hi.\n");
	// OpenRouter's list prices the model, so the cost events have dollars.
	const models = [
		{
			id: "openai/gpt-6-luna",
			name: "Luna",
			context_length: 128000,
			pricing: { prompt: "0.000001", completion: "0.000008" },
		},
	];
	edupi = startEdupi({ models, responses: [{ content: [bash], stopReason: "toolUse" }, "Hello there."] }, [], { dir });
	// Step mode on: release each pause until the run settles.
	await edupi.command("debug_set_step_mode", { enabled: true, breakpoints: ["beforeModelRequest"] });
	edupi.sendLine(JSON.stringify({ type: "prompt", message: "Hi?" }));
	const pauses = () => edupi.seen.filter((m) => m.type === "trace" && m.name === "paused").length;
	for (let released = 0; !edupi.seen.some((m) => m.type === "agent_settled"); released++) {
		await edupi.until(() => pauses() > released || edupi.seen.some((m) => m.type === "agent_settled"));
		if (pauses() > released) await edupi.command("debug_continue");
	}

	const first = (name: string, where: (m: Message) => boolean = () => true) =>
		edupi.seen.find((m) => m.type === "trace" && m.name === name && where(m));
	const actual: Record<string, Message | undefined> = {
		// the compaction events are in the next test
		modelRequest: first("modelRequest"),
		toolDispatch: first("toolDispatch"),
		toolOutput: first("toolOutput"),
		streamEvent: first("streamEvent", (m) => Boolean(m.event.choices[0]?.delta?.content)), // a text chunk, as in the fixture
		modelResponse: first("modelResponse"),
		loopIteration: first("loopIteration"), // the tool call's iteration, as in the fixture
		promptAssembled: first("promptAssembled"),
		skillsLoaded: first("skillsLoaded"),
		pricing: first("pricing"),
		cost: first("cost"),
		paused: first("paused"),
		resumed: first("resumed"),
	};
	expect(actual.skillsLoaded!.skills.map((s: Message) => s.name)).toEqual(["greet"]);
	// Every shared event is checked: the compaction events in the next test.
	expect([...Object.keys(actual), "compactionRequest", "compacted"].sort()).toEqual(Object.keys(shared).sort());
	for (const [name, message] of Object.entries(actual)) {
		expect(message, name).toBeDefined();
		expect(shapeErrors(fixture(name), message), name).toEqual([]);
		for (const [field, type] of Object.entries(shared[name]))
			expect(jsonType(message![field]), `${name}.${field}`).toBe(type);
	}
});

test("edupi's compaction trace events match the protocol fixtures", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "edupi-test-")));
	mkdirSync(join(dir, "home", "agent"), { recursive: true });
	writeFileSync(join(dir, "home", "agent", "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 6 } }));
	edupi = startEdupi({ responses: ["Hello there.", "Hello again.", "## Goal\nSay hello."] }, [], { dir });
	for (const message of ["Hi?", "Hi again?"]) {
		const settled = edupi.seen.filter((m) => m.type === "agent_settled").length;
		edupi.sendLine(JSON.stringify({ type: "prompt", message }));
		await edupi.until(() => edupi.seen.filter((m) => m.type === "agent_settled").length > settled);
	}
	await edupi.command("compact");

	for (const name of ["compactionRequest", "compacted"]) {
		const message = edupi.seen.find((m) => m.type === "trace" && m.name === name);
		expect(message, name).toBeDefined();
		expect(shapeErrors(fixture(name), message), name).toEqual([]);
		for (const [field, type] of Object.entries(shared[name]))
			expect(jsonType(message![field]), `${name}.${field}`).toBe(type);
	}
});
