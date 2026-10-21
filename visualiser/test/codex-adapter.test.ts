// Seam C: a recorded educodex transcript goes through the Codex adapter into the neutral view model.
// The fixture is educodex's stdout for the demo turn (see test/record-educodex.mjs).
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { codexActions } from "../src/adapters/codex/mapping";
import { initialView, reduceView, type View } from "../src/view/model";

function replay(file: string): View {
	const lines = readFileSync(new URL(`fixtures/${file}`, import.meta.url), "utf8")
		.split("\n")
		.filter(Boolean);
	return lines
		.map((l) => JSON.parse(l))
		.flatMap(codexActions)
		.reduce(reduceView, initialView);
}

describe("Codex adapter on the educodex demo turn", () => {
	const view = replay("educodex-demo.out.jsonl");
	const turn = view.turns[0];
	const tools = turn.entries.filter((e) => e.kind === "tool");

	test("one completed turn in the started thread", () => {
		expect(view.sessionId).toBe("0a8511dc-5670-4a4c-8b9b-c33ceb6e8066");
		expect(view.turns).toHaveLength(1);
		expect(turn.status).toBe("completed");
		expect(turn.durationMs).toBe(127);
		expect(view.running).toBe(false);
	});

	test("entries in the order the items started", () => {
		expect(turn.entries.map((e) => (e.kind === "native" ? `native:${e.part.type}` : e.kind))).toEqual([
			"user",
			"reasoning",
			"native:plan",
			"tool",
			"native:plan",
			"tool",
			"tool",
			"reasoning",
			"tool",
			"native:plan",
			"assistant",
		]);
		expect(turn.entries[0]).toMatchObject({
			kind: "user",
			text: "Create hello.py that prints a greeting, then run it.",
		});
		expect(turn.entries[1]).toMatchObject({
			kind: "reasoning",
			summary: ["The user wants a greeting script. I'll plan, look around, write it, run it."],
		});
		expect(turn.entries.at(-1)).toMatchObject({
			kind: "assistant",
			streaming: false,
			text: "Created `hello.py` and ran it: it prints `hello from educodex`. I left the build directory alone.",
		});
	});

	test("tool calls carry name, arguments, output and status", () => {
		expect(tools.map((t) => t.kind === "tool" && [t.title, t.status])).toEqual([
			["ls -la", "completed"],
			["hello.py", "completed"],
			["python3 hello.py", "completed"],
			["rm -rf build", "declined"],
		]);
		expect(tools[2]).toMatchObject({
			toolKind: "shell",
			output: "hello from educodex\n",
			exitCode: 0,
			arguments: { command: "python3 hello.py" },
		});
		expect(tools[1]).toMatchObject({
			name: "apply_patch",
			part: { protocol: "codex-app-server", type: "fileChange" },
		});
	});

	test("trace events, costs and pricing", () => {
		expect(view.events.filter((e) => e.trace && e.name === "modelRequest")).toHaveLength(7);
		expect(view.events.find((e) => e.name === "turn/started")?.trace).toBe(false);
		expect(view.costs).toHaveLength(7);
		expect(view.pricing).not.toBeNull();
		expect(view.approvals).toEqual([]);
	});
});
