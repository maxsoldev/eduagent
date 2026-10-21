// Seam A: what edupi sends to the model. The faux provider stands in for OpenRouter's Chat
// Completions endpoint and records each request.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { type Message, type RpcClient, startEdupi } from "./rpc-client.ts";

let edupi: RpcClient;
afterEach(async () => {
	await edupi?.close();
});

async function prompt(message: string) {
	const settled = edupi.seen.filter((m) => m.type === "agent_settled").length;
	edupi.sendLine(JSON.stringify({ type: "prompt", message }));
	await edupi.until(() => edupi.seen.filter((m) => m.type === "agent_settled").length > settled);
}

test("each request is a stateless Chat Completions body on OpenRouter with the whole conversation", async () => {
	edupi = startEdupi({ responses: ["First answer.", "Second answer."] });
	await prompt("First question?");
	await prompt("Second question?");

	const [first, second] = edupi.requests();
	expect(first.url).toBe("https://openrouter.ai/api/v1/chat/completions");
	expect(first.body).toEqual({
		model: "openai/gpt-6-luna",
		messages: [
			{ role: "system", content: expect.stringMatching(/^You are an expert coding assistant operating inside pi/) }, // rpc-system-prompt.test.ts checks it
			{ role: "user", content: [{ type: "text", text: "First question?" }] },
		],
		stream: true,
		stream_options: { include_usage: true },
		store: false,
		max_completion_tokens: 16384,
		tools: expect.any(Array), // the tools are declared in the transcript; rpc-tools.test.ts checks them
	});
	expect(first.body.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual([
		"read",
		"bash",
		"edit",
		"write",
	]);
	expect(second.body.messages).toEqual([
		first.body.messages[0],
		{ role: "user", content: [{ type: "text", text: "First question?" }] },
		{ role: "assistant", content: "First answer." },
		{ role: "user", content: [{ type: "text", text: "Second question?" }] },
	]);
});

test("any OpenRouter model id is accepted with --model", async () => {
	edupi = startEdupi({ responses: ["Hi."] }, ["--model", "anthropic/claude-sonnet-5"]);
	const state = await edupi.command("get_state");
	expect(state.data.model).toMatchObject({
		id: "anthropic/claude-sonnet-5",
		provider: "openrouter",
		api: "openai-completions",
	});
	await prompt("Hi?");
	expect(edupi.requests()[0].body.model).toBe("anthropic/claude-sonnet-5");
	expect(edupi.seen.find((m) => m.type === "message_end" && m.message.role === "assistant")!.message.model).toBe(
		"anthropic/claude-sonnet-5",
	);
});

test("unknown commands and bad JSON get pi's error responses", async () => {
	edupi = startEdupi({ responses: [] });
	expect(await edupi.command("get_tree")).toEqual({
		id: "1",
		type: "response",
		command: "get_tree",
		success: false,
		error: "Unknown command: get_tree",
	});
	edupi.sendLine("not json");
	const parse = await edupi.until((m) => m.command === "parse");
	expect(parse).toEqual({
		type: "response",
		command: "parse",
		success: false,
		error: expect.stringMatching(/^Failed to parse command: /),
	});
});

test("without an API key a prompt is refused before the run starts", async () => {
	const home = mkdtempSync(join(tmpdir(), "edupi-home-"));
	// --offline (pi's flag): no model list from OpenRouter, so the test needs no network.
	const proc = spawn(
		process.execPath,
		[new URL("../bin/edupi.mjs", import.meta.url).pathname, "--mode", "rpc", "--offline"],
		{ env: { ...process.env, OPENROUTER_API_KEY: "", EDUPI_CODING_AGENT_DIR: home } },
	);
	let out = "";
	const firstLine = new Promise((resolve) =>
		proc.stdout.on("data", (d) => {
			out += d;
			if (out.includes("\n")) resolve(out);
		}),
	);
	proc.stdin.write(`${JSON.stringify({ id: "1", type: "prompt", message: "Hi" })}\n`);
	await firstLine;
	proc.stdin.end();
	await new Promise((r) => proc.once("close", r));
	const lines = out
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
	expect(lines).toEqual([
		{
			id: "1",
			type: "response",
			command: "prompt",
			success: false,
			error: expect.stringMatching(/^No API key found for openrouter\./),
		},
	]);
});

// One model as OpenRouter's GET /models lists it: prices are USD per token, as strings.
const LUNA = {
	id: "openai/gpt-6-luna",
	name: "OpenAI: GPT-6 Luna",
	context_length: 400000,
	top_provider: { context_length: 272000, max_completion_tokens: 128000 },
	pricing: { prompt: "0.00000125", completion: "0.00001", input_cache_read: "0.000000125" },
	supported_parameters: ["tools", "reasoning", "max_tokens"],
};

test("model metadata comes from OpenRouter's model list: context window, output limit, prices", async () => {
	edupi = startEdupi({ models: [LUNA], responses: ["Hi."] });
	const { model } = (await edupi.command("get_state")).data;
	expect(model).toEqual({
		id: "openai/gpt-6-luna",
		name: "OpenAI: GPT-6 Luna",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	});

	// The output limit goes into the request; the prices turn usage into cost.
	await prompt("Hi?");
	expect(edupi.requests()[0].body.max_completion_tokens).toBe(128000);
	const reply = edupi.seen.find((m) => m.type === "message_end" && m.message.role === "assistant")!.message;
	expect(reply.usage.cost.input).toBeCloseTo(reply.usage.input * 1.25e-6, 12);
	expect(reply.usage.cost.output).toBeCloseTo(reply.usage.output * 1e-5, 12);
});

test("a model OpenRouter does not list gets pi's defaults for custom models", async () => {
	edupi = startEdupi({ models: [LUNA], responses: [] }, ["--model", "someone/new-model"]);
	const { model } = (await edupi.command("get_state")).data;
	expect(model).toMatchObject({
		id: "someone/new-model",
		name: "someone/new-model",
		reasoning: false,
		contextWindow: 128000,
		maxTokens: 16384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
});

// pi's transformMessages (packages/ai/src/api/transform-messages.ts) cleans the transcript before each request.
test("an aborted reply is left out of later requests, even with a half-streamed tool call", async () => {
	const write = {
		type: "toolCall",
		id: "call_w",
		name: "write",
		arguments: { path: "notes.txt", content: "a long text ".repeat(40) },
	};
	edupi = startEdupi({ tokensPerSecond: 20, responses: [{ content: [write], stopReason: "toolUse" }, "Hello."] });
	edupi.sendLine(JSON.stringify({ type: "prompt", message: "Write notes." }));
	await edupi.until((m) => m.type === "message_update" && m.assistantMessageEvent.type === "toolcall_delta");
	await edupi.command("abort");
	const aborted = edupi.seen.find((m) => m.type === "message_end" && m.message.role === "assistant")!.message;
	expect(aborted).toMatchObject({ stopReason: "aborted", content: [{ type: "toolCall", id: "call_w" }] });

	await prompt("Say hello instead.");
	const messages = edupi.requests()[1].body.messages;
	const text = (m: Message) =>
		Array.isArray(m.content) ? m.content.map((c: Message) => c.text).join("") : (m.content ?? "");
	expect(messages.map((m: Message) => [m.role, m.role === "system" ? "" : text(m)])).toEqual([
		["system", ""],
		["user", "Write notes."],
		["user", "Say hello instead."],
	]);
});

test("a stream that fails mid tool call keeps only the call's fields, not the stream's scratch buffers", async () => {
	const write = { type: "toolCall", id: "call_w", name: "write", arguments: { path: "a.txt", content: "x" } };
	// streamError: the connection breaks after the scripted chunks, before the finish chunk.
	edupi = startEdupi({ responses: [{ content: [write], stopReason: "toolUse", streamError: "socket hang up" }] });
	await prompt("Write.");
	const reply = edupi.seen.find((m) => m.type === "message_end" && m.message.role === "assistant")!.message;
	expect(reply).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("socket hang up") });
	// pi's catch block deletes partialArgs and streamIndex, so they are never persisted.
	expect(Object.keys(reply.content[0]).sort()).toEqual(["arguments", "id", "name", "type"]);
});

test("an HTTP error shows its status and the error body, as pi's formatProviderError writes it", async () => {
	edupi = startEdupi({ responses: [{ error: { status: 400, message: "Invalid model" } }] });
	await prompt("Hi?");
	const reply = edupi.seen.find((m) => m.type === "message_end" && m.message.role === "assistant")!.message;
	// The SDK's message is "400 Invalid model"; pi prefers the parsed body when the message lacks it.
	expect(reply).toMatchObject({ stopReason: "error", errorMessage: '400: {"message":"Invalid model","code":400}' });
});

test("unpaired surrogates are removed from the text sent to the model; emoji stay", async () => {
	edupi = startEdupi({ responses: ["Hi."] });
	await prompt("cut \ud83d here, keep \ud83d\ude48");
	const user = edupi.requests()[0].body.messages.find((m: Message) => m.role === "user");
	expect(user.content).toEqual([{ type: "text", text: "cut  here, keep \ud83d\ude48" }]);
});

test("a null for an optional tool argument counts as left out, as pi's validation reads it", async () => {
	const read = {
		type: "toolCall",
		id: "r1",
		name: "read",
		arguments: { path: "notes.txt", offset: null, limit: null },
	};
	edupi = startEdupi({ responses: [{ content: [read], stopReason: "toolUse" }, "Read it."] });
	writeFileSync(join(edupi.dir, "notes.txt"), "line 1\nline 2");
	await prompt("Read the notes.");
	const end = edupi.seen.find((m) => m.type === "tool_execution_end")!;
	expect(end).toMatchObject({ isError: false, result: { content: [{ type: "text", text: "line 1\nline 2" }] } });
});

test("finished tool-call arguments with a raw newline or a bad escape in a string are repaired, as pi does", async () => {
	// rawArguments: the faux streams this text as the arguments instead of JSON.stringify(arguments).
	const write = {
		type: "toolCall",
		id: "w1",
		name: "write",
		arguments: {},
		rawArguments: '{"path": "a.txt", "content": "one\ntwo \\d"}',
	};
	edupi = startEdupi({ responses: [{ content: [write], stopReason: "toolUse" }, "Done."] });
	await prompt("Write.");
	expect(edupi.seen.find((m) => m.type === "tool_execution_end")).toMatchObject({ isError: false });
	expect(readFileSync(join(edupi.dir, "a.txt"), "utf8")).toBe("one\ntwo \\d");
});

test("conversation requests carry the session id for OpenRouter's cache affinity; a summary request (cacheRetention none) does not", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "edupi-test-")));
	mkdirSync(join(dir, "home", "agent"), { recursive: true });
	writeFileSync(join(dir, "home", "agent", "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 9 } }));
	edupi = startEdupi({ responses: ["First answer with some words.", "Second answer.", "## Goal\nSUMMARY"] }, [], {
		dir,
	});
	const { sessionId } = (await edupi.command("get_state")).data;
	await prompt("q1");
	await prompt("q2");
	await edupi.command("compact");
	// The faux log keeps the x-session-id header of each request.
	expect(edupi.requests().map((r) => r.headers?.["x-session-id"])).toEqual([sessionId, sessionId, undefined]);
});

test("a tool call without a result gets pi's synthetic error result before the next user message", async () => {
	// A real pi session that stopped while its two tool calls ran: the file ends at the tool-call reply.
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "edupi-test-")));
	const lines = readFileSync(new URL("./fixtures/pi/session-prompt-and-tools.jsonl", import.meta.url), "utf8")
		.trim()
		.split("\n");
	const file = join(dir, "session.jsonl");
	writeFileSync(
		file,
		`${lines
			.slice(
				0,
				lines.findIndex((l) => l.includes('"toolResult"')),
			)
			.join("\n")}\n`,
	);
	edupi = startEdupi({ responses: ["Sorry, starting over."] }, ["--session", file], { dir });

	await prompt("Are you there?");
	const calls = JSON.parse(lines.find((l) => l.includes('"toolUse"'))!).message.content.map((c: Message) => c.id);
	const messages = edupi.requests()[0].body.messages;
	expect(
		messages
			.slice(-4)
			.map((m: Message) => [
				m.role,
				m.tool_calls?.map((c: Message) => c.id) ?? m.tool_call_id,
				m.role === "tool" ? m.content : undefined,
			]),
	).toEqual([
		["assistant", calls, undefined],
		["tool", calls[0], "No result provided"],
		["tool", calls[1], "No result provided"],
		["user", undefined, undefined],
	]);
});
