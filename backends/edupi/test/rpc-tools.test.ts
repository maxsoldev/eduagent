// Seam A: pi's default coding tools (read, bash, edit, write) over pi's RPC protocol. The faux
// provider scripts the tool calls; the tools run for real in the test's temporary directory.
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { type Message, type RpcClient, startEdupi } from "./rpc-client.ts";

const FIXTURES = new URL("./fixtures/pi/", import.meta.url);
/** Real pi's request after a bash and a read call: its tools field and its last messages. */
const piRequest = JSON.parse(readFileSync(new URL("tools-request.json", FIXTURES), "utf8"));

let edupi: RpcClient;
afterEach(async () => {
	await edupi?.close();
});

const call = (id: string, name: string, args: object) => ({ type: "toolCall", id, name, arguments: args });
const toolUse = (...calls: object[]) => ({ content: calls, stopReason: "toolUse" });

async function prompt(message: string) {
	const settled = edupi.seen.filter((m) => m.type === "agent_settled").length;
	edupi.sendLine(JSON.stringify({ type: "prompt", message }));
	await edupi.until(() => edupi.seen.filter((m) => m.type === "agent_settled").length > settled);
}

const events = (type: string) => edupi.seen.filter((m) => m.type === type);
const toolEnd = (id: string) => edupi.seen.find((m) => m.type === "tool_execution_end" && m.toolCallId === id)!;

test("tools go to the model and their results come back in pi's Chat Completions shape", async () => {
	edupi = startEdupi({
		responses: [
			toolUse(call("call_1", "bash", { command: "echo hi" }), call("call_2", "read", { path: "a.txt" })),
			"Done.",
		],
	});
	writeFileSync(join(edupi.dir, "a.txt"), "file a\n");
	await prompt("run tools");

	const [first, second] = edupi.requests().map((r) => r.body);
	expect(first.tools).toEqual(piRequest.tools); // the same specs real pi sends
	expect(Object.keys(first)).toEqual([
		"model",
		"messages",
		"stream",
		"stream_options",
		"store",
		"max_completion_tokens",
		"tools",
	]);
	expect(second.messages.slice(-3)).toEqual(piRequest.messages.slice(-3)); // assistant tool_calls, then one tool message per call
	expect(second.messages.slice(-3)[0]).toEqual({
		role: "assistant",
		content: null,
		tool_calls: [
			{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"echo hi"}' } },
			{ id: "call_2", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } },
		],
	});
});

/** pi's event types, one line each; tool events name their call. */
function eventOrder(): string[] {
	return edupi.seen
		.filter((m) => m.type !== "trace" && m.type !== "message_update" && m.type !== "response")
		.map((m) =>
			m.type.startsWith("tool_execution")
				? `${m.type} ${m.toolCallId}`
				: m.type === "message_start" || m.type === "message_end"
					? `${m.type} ${m.message.role}${m.message.toolCallId ? ` ${m.message.toolCallId}` : ""}`
					: m.type,
		);
}

test("two tool calls of one reply run in parallel: ends in completion order, results in call order", async () => {
	edupi = startEdupi({
		responses: [
			toolUse(
				call("slow", "bash", { command: "sleep 0.6; echo slow" }),
				call("fast", "bash", { command: "sleep 0.1; echo fast" }),
			),
			"Both ran.",
		],
	});
	await prompt("Run two commands.");

	expect(eventOrder().filter((t) => !t.startsWith("tool_execution_update"))).toEqual([
		"agent_start",
		"turn_start",
		"message_start system",
		"message_end system",
		"message_start user",
		"message_end user",
		"message_start assistant",
		"message_end assistant",
		"tool_execution_start slow", // both start first, in call order
		"tool_execution_start fast",
		"tool_execution_end fast", // the faster one ends first
		"tool_execution_end slow",
		"message_start toolResult slow",
		"message_end toolResult slow", // the results follow in call order
		"message_start toolResult fast",
		"message_end toolResult fast",
		"turn_end",
		"turn_start", // the model is called again with the results
		"message_start assistant",
		"message_end assistant",
		"turn_end",
		"agent_end",
		"agent_settled",
	]);
	// They overlapped: the fast one ended while the slow one was still running.
	expect(toolEnd("fast").durationMs).toBeLessThan(toolEnd("slow").durationMs);
	expect(toolEnd("slow").result.content).toEqual([{ type: "text", text: "slow\n" }]);

	const turnEnd = events("turn_end")[0];
	expect(turnEnd.toolResults.map((r: Message) => r.toolCallId)).toEqual(["slow", "fast"]);
	expect(events("agent_end")[0].messages.map((m: Message) => m.role)).toEqual([
		"system",
		"user",
		"assistant",
		"toolResult",
		"toolResult",
		"assistant",
	]);
});

test("bash streams its output so far as tool_execution_update, and a non-zero exit is an error result", async () => {
	edupi = startEdupi({
		responses: [toolUse(call("c1", "bash", { command: "echo one; sleep 0.4; echo two; exit 3" })), "Saw it."],
	});
	await prompt("Run it.");

	const updates = events("tool_execution_update").map((m) => m.partialResult);
	expect(updates[0]).toEqual({ content: [] }); // pi's first update, before any output
	expect(updates.map((u) => u.content[0]?.text)).toContain("one\n"); // the first line, before the command ended
	expect(updates.at(-1).content).toEqual([{ type: "text", text: "one\ntwo\n" }]);

	expect(toolEnd("c1")).toMatchObject({
		toolName: "bash",
		isError: true,
		result: {
			content: [{ type: "text", text: "one\ntwo\n\n\nCommand exited with code 3" }],
			structuredContent: { exit_code: 3 },
		},
	});
	const tool = edupi.requests()[1].body.messages.at(-1);
	expect(tool).toEqual({ role: "tool", content: "one\ntwo\n\n\nCommand exited with code 3", tool_call_id: "c1" });
});

test("read returns the file's lines and tells the model how to read on", async () => {
	edupi = startEdupi({
		responses: [toolUse(call("r1", "read", { path: "notes.txt", offset: 2, limit: 2 })), "Read it."],
	});
	writeFileSync(join(edupi.dir, "notes.txt"), "line 1\nline 2\nline 3\nline 4\nline 5");
	await prompt("Read the notes.");

	expect(toolEnd("r1")).toMatchObject({
		isError: false,
		result: {
			content: [{ type: "text", text: "line 2\nline 3\n\n[2 more lines in file. Use offset=4 to continue.]" }],
		},
	});
});

test("edit replaces exact text, keeps the rest of the file and returns pi's diff in details", async () => {
	edupi = startEdupi({
		responses: [
			toolUse(
				call("e1", "edit", { path: "app.py", edits: [{ oldText: "print('hi')", newText: "print('hello')" }] }),
			),
			"Edited.",
		],
	});
	writeFileSync(join(edupi.dir, "app.py"), "import sys\n\nprint('hi')\nsys.exit(0)\n");
	await prompt("Say hello instead.");

	expect(readFileSync(join(edupi.dir, "app.py"), "utf8")).toBe("import sys\n\nprint('hello')\nsys.exit(0)\n");
	const end = toolEnd("e1");
	expect(end.result.content).toEqual([{ type: "text", text: "Successfully replaced 1 block(s) in app.py." }]);
	expect(end.result.details.diff).toBe(" 1 import sys\n 2 \n-3 print('hi')\n+3 print('hello')\n 4 sys.exit(0)");
	expect(end.result.details.firstChangedLine).toBe(3);
	expect(end.result.details.patch).toContain("-print('hi')\n+print('hello')");
	// The model reads only the text; the diff is for the user interface.
	expect(edupi.requests()[1].body.messages.at(-1)).toEqual({
		role: "tool",
		content: "Successfully replaced 1 block(s) in app.py.",
		tool_call_id: "e1",
	});
});

test("write creates the file and its folders", async () => {
	edupi = startEdupi({
		responses: [toolUse(call("w1", "write", { path: "src/hello.py", content: "print('hi')\n" })), "Written."],
	});
	await prompt("Write hello.py.");

	expect(readFileSync(join(edupi.dir, "src", "hello.py"), "utf8")).toBe("print('hi')\n");
	expect(toolEnd("w1")).toMatchObject({
		isError: false,
		result: { content: [{ type: "text", text: "Successfully wrote to src/hello.py" }] },
	});
});

test("a failing tool call becomes an error result the model reads; the run goes on", async () => {
	edupi = startEdupi({
		responses: [
			toolUse(
				call("bad1", "edit", { path: "app.py", edits: [{ oldText: "nope", newText: "x" }] }), // text not in the file
				call("bad2", "read", { offset: 3 }), // no path: fails the schema
				call("bad3", "grep", { pattern: "x" }), // not one of edupi's tools
			),
			"I will try again.",
		],
	});
	writeFileSync(join(edupi.dir, "app.py"), "print('hi')\n");
	await prompt("Fix it.");

	expect(toolEnd("bad1")).toMatchObject({
		isError: true,
		result: {
			content: [
				{
					type: "text",
					text: "Could not find the exact text in app.py. The old text must match exactly including all whitespace and newlines.",
				},
			],
		},
	});
	expect(toolEnd("bad2").isError).toBe(true);
	expect(toolEnd("bad2").result.content[0].text).toMatch(/^Validation failed for tool "read":\n {2}- path: /);
	expect(toolEnd("bad3")).toMatchObject({
		isError: true,
		result: { content: [{ type: "text", text: "Tool grep not found" }] },
	});

	const results = events("message_end")
		.filter((m) => m.message.role === "toolResult")
		.map((m) => m.message);
	expect(results.map((r) => [r.toolCallId, r.isError])).toEqual([
		["bad1", true],
		["bad2", true],
		["bad3", true],
	]);
	expect(
		edupi
			.requests()[1]
			.body.messages.slice(-3)
			.map((m: Message) => m.role),
	).toEqual(["tool", "tool", "tool"]);
	expect(events("agent_end")[0].messages.at(-1).content).toEqual([{ type: "text", text: "I will try again." }]);
});

const traces = (name: string) => edupi.seen.filter((m) => m.type === "trace" && m.name === name);

test("tool calls are traced: the tool specs the model got, each dispatch and each output", async () => {
	edupi = startEdupi({
		responses: [
			toolUse(call("t1", "bash", { command: "echo traced" }), call("t2", "read", { path: "missing.txt" })),
			"Ok.",
			"Again.",
		],
	});
	await prompt("Trace the tools.");

	const [registered] = traces("toolsRegistered");
	expect(registered.tools).toEqual(edupi.requests()[0].body.tools); // the Chat Completions specs, as sent
	expect(traces("toolDispatch")).toEqual([
		{
			type: "trace",
			name: "toolDispatch",
			tool: "bash",
			callId: "t1",
			arguments: { command: "echo traced" },
			parallel: true,
		},
		{
			type: "trace",
			name: "toolDispatch",
			tool: "read",
			callId: "t2",
			arguments: { path: "missing.txt" },
			parallel: true,
		},
	]);
	const outputs = traces("toolOutput");
	expect(outputs.find((o) => o.callId === "t1")).toEqual({
		type: "trace",
		name: "toolOutput",
		tool: "bash",
		callId: "t1",
		output: "traced\n",
		isError: false,
		durationMs: expect.any(Number),
		tokens: 2,
	});
	expect(outputs.find((o) => o.callId === "t2")).toMatchObject({
		tool: "read",
		isError: true,
		output: expect.stringContaining("ENOENT"),
	});

	// Each trace comes right after the pi event it explains.
	const order = edupi.seen.map((m) =>
		m.type === "trace" ? m.name : m.type.startsWith("tool_execution") ? `${m.type} ${m.toolCallId}` : m.type,
	);
	expect(order[order.indexOf("tool_execution_start t1") + 1]).toBe("toolDispatch");
	expect(order[order.indexOf("tool_execution_end t1") + 1]).toBe("toolOutput");

	await prompt("Same tools?");
	expect(traces("toolsRegistered")).toHaveLength(1); // sent again only when the tool set changes
});

test("two parallel edits of one file both apply: edit and write wait in a per-file queue", async () => {
	edupi = startEdupi({
		responses: [
			toolUse(
				call("e1", "edit", { path: "app.py", edits: [{ oldText: "one", newText: "ONE" }] }),
				call("e2", "edit", { path: "./app.py", edits: [{ oldText: "two", newText: "TWO" }] }), // same file, other spelling
			),
			"Both edited.",
		],
	});
	writeFileSync(join(edupi.dir, "app.py"), "one\ntwo\n");
	await prompt("Change both lines.");

	expect([toolEnd("e1").isError, toolEnd("e2").isError]).toEqual([false, false]);
	expect(readFileSync(join(edupi.dir, "app.py"), "utf8")).toBe("ONE\nTWO\n");
});

test("bash refuses a timeout above the timer limit, after its first update, as pi does", async () => {
	edupi = startEdupi({
		responses: [toolUse(call("b1", "bash", { command: "echo never", timeout: 3_000_000 })), "Too long."],
	});
	await prompt("Wait long.");

	expect(events("tool_execution_update").map((m) => m.partialResult)).toEqual([{ content: [] }]);
	expect(toolEnd("b1")).toMatchObject({
		isError: true,
		result: { content: [{ type: "text", text: "Invalid timeout: maximum is 2147483.647 seconds" }] },
	});
});

test("bash names the size of the open last line when it keeps only its end, as pi's accumulator counts it", async () => {
	const long = "head -c 60000 /dev/zero | tr '\\0' a";
	edupi = startEdupi({
		responses: [
			toolUse(call("open", "bash", { command: long }), call("closed", "bash", { command: `${long}; echo` })),
			"Long.",
		],
	});
	await prompt("Print a long line.");

	const note = (id: string) => toolEnd(id).result.content[0].text.split("\n\n").at(-1);
	expect(note("open")).toMatch(
		/^\[Showing last 50\.0KB of line 1 \(line is 58\.6KB\)\. Full output: .*pi-bash-[0-9a-f]{16}\.log\]$/,
	);
	// The line ended with a newline: pi's open line is then empty, so pi says 0B.
	expect(note("closed")).toMatch(/^\[Showing last 50\.0KB of line 1 \(line is 0B\)\. Full output: /);
});

test("bash does not pass on PI_* session variables it inherited (edupi run from inside pi); it sets its own", async () => {
	process.env.PI_SESSION_ID = "parent-session";
	process.env.PI_MODEL = "parent-model";
	try {
		edupi = startEdupi({
			responses: [toolUse(call("env", "bash", { command: 'echo "[$PI_SESSION_ID][$PI_MODEL]"' })), "Clean."],
		});
	} finally {
		delete process.env.PI_SESSION_ID;
		delete process.env.PI_MODEL;
	}
	await prompt("Show the session.");

	const { sessionId } = (await edupi.command("get_state")).data;
	expect(toolEnd("env").result.content).toEqual([{ type: "text", text: `[${sessionId}][openai/gpt-6-luna]\n` }]);
});

test("a file:// URL is a path, as in pi's resolveToCwd", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "edupi-url-")));
	writeFileSync(join(dir, "a b.txt"), "by url\n");
	const url = pathToFileURL(join(dir, "a b.txt")).href; // file:///.../a%20b.txt
	edupi = startEdupi({ responses: [toolUse(call("u1", "read", { path: url })), "Read."] }, [], { dir });
	await prompt("Read it.");

	expect(toolEnd("u1")).toMatchObject({ isError: false, result: { content: [{ type: "text", text: "by url\n" }] } });
});
