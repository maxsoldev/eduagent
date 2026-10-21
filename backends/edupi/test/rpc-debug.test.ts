// Seam A: edupi's debug_ commands, the teaching extras on top of pi's RPC protocol. Step mode
// pauses the loop before each model request and tool call; get context returns the exact next
// request. Real pi has neither and answers both with "Unknown command".
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { type Message, type RpcClient, startEdupi } from "./rpc-client.ts";

let edupi: RpcClient;
afterEach(async () => {
	await edupi?.close();
});

const traces = (name: string) => edupi.seen.filter((m) => m.type === "trace" && m.name === name);
const count = (match: (m: Message) => boolean) => edupi.seen.filter(match).length;
const isTrace = (name: string) => (m: Message) => m.type === "trace" && m.name === name;

/** Waits until the nth (1-based) message that matches has come. */
const nth = (n: number, match: (m: Message) => boolean) => edupi.until(() => count(match) >= n);

test("step mode pauses before the model request until debug_continue", async () => {
	edupi = startEdupi({ responses: ["Hello."] });
	const on = await edupi.command("debug_set_step_mode", { enabled: true });
	expect(on).toMatchObject({
		success: true,
		data: { enabled: true, breakpoints: ["afterToolCall", "beforeModelRequest", "beforeToolCall"] },
	});

	edupi.sendLine(JSON.stringify({ type: "prompt", message: "Hi?" }));
	const paused = await edupi.until(isTrace("paused"));
	expect(paused).toMatchObject({ breakpoint: "beforeModelRequest", info: { messages: 2, tools: 4 } });
	await new Promise((r) => setTimeout(r, 200));
	expect(edupi.requests()).toHaveLength(0); // nothing sent while paused
	expect(traces("modelRequest")).toHaveLength(0);

	expect(await edupi.command("debug_continue")).toMatchObject({ success: true });
	await edupi.until("agent_settled");
	expect(edupi.requests()).toHaveLength(1);
	const order = edupi.seen.map((m) => (m.type === "trace" ? m.name : m.type));
	expect(order.indexOf("paused")).toBeLessThan(order.indexOf("resumed"));
	expect(order.indexOf("resumed")).toBeLessThan(order.indexOf("modelRequest"));
	expect(traces("resumed")[0]).toMatchObject({ breakpoint: "beforeModelRequest" });
});

test("step mode pauses before and after each tool call; parallel calls pause one at a time", async () => {
	const call = (id: string, command: string) => ({ type: "toolCall", id, name: "bash", arguments: { command } });
	edupi = startEdupi({
		responses: [
			{ content: [call("call_1", "echo one"), call("call_2", "echo two")], stopReason: "toolUse" },
			"Done.",
		],
	});
	await edupi.command("debug_set_step_mode", { enabled: true });
	edupi.sendLine(JSON.stringify({ type: "prompt", message: "Run two commands." }));

	// Release each pause in turn and record where the loop stopped.
	const stops: Message[] = [];
	const settled = () => edupi.seen.some((m) => m.type === "agent_settled");
	while (true) {
		await edupi.until(() => count(isTrace("paused")) > stops.length || settled());
		if (count(isTrace("paused")) === stops.length) break; // settled
		// Only one pause is open at a time: the other parallel call waits.
		expect(count(isTrace("paused"))).toBe(stops.length + 1);
		expect(count(isTrace("resumed"))).toBe(stops.length);
		stops.push(traces("paused")[stops.length]);
		await edupi.command("debug_continue");
	}
	expect(stops.map((s) => [s.breakpoint, s.info.callId])).toEqual([
		["beforeModelRequest", undefined],
		["beforeToolCall", "call_1"],
		["beforeToolCall", "call_2"],
		["afterToolCall", expect.any(String)],
		["afterToolCall", expect.any(String)],
		["beforeModelRequest", undefined],
	]);
	expect(stops[1].info).toEqual({ tool: "bash", callId: "call_1" });
	expect(new Set(stops.slice(3, 5).map((s) => s.info.callId))).toEqual(new Set(["call_1", "call_2"]));
	// A tool runs only after its beforeToolCall pause.
	const order = edupi.seen.map((m) => (m.type === "trace" ? `${m.name}:${m.breakpoint ?? ""}` : m.type));
	expect(order.indexOf("tool_execution_end")).toBeGreaterThan(order.indexOf("resumed:beforeToolCall"));
});

test("only the chosen breakpoints pause, and turning step mode off releases a pause", async () => {
	const call = { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "echo hi" } };
	edupi = startEdupi({ responses: [{ content: [call], stopReason: "toolUse" }, "Done."] });
	const on = await edupi.command("debug_set_step_mode", {
		enabled: true,
		breakpoints: ["beforeToolCall", "nonsense"],
	});
	expect(on.data).toEqual({ enabled: true, breakpoints: ["beforeToolCall"] });
	edupi.sendLine(JSON.stringify({ type: "prompt", message: "Run it." }));
	expect(await edupi.until(isTrace("paused"))).toMatchObject({ breakpoint: "beforeToolCall" });

	expect((await edupi.command("debug_set_step_mode", { enabled: false })).data).toEqual({
		enabled: false,
		breakpoints: ["beforeToolCall"],
	});
	await edupi.until("agent_settled");
	expect(traces("paused")).toHaveLength(1);
	expect(traces("resumed")).toHaveLength(1);
	expect(edupi.requests()).toHaveLength(2);
});

test("abort while paused ends the pause and the run", async () => {
	edupi = startEdupi({ responses: ["Never sent."] });
	await edupi.command("debug_set_step_mode", { enabled: true });
	edupi.sendLine(JSON.stringify({ type: "prompt", message: "Hi?" }));
	await edupi.until(isTrace("paused"));

	await edupi.command("abort");
	expect(await edupi.until("agent_settled")).toMatchObject({ aborted: true });
	expect(traces("resumed")).toHaveLength(1);
	expect(edupi.requests()).toHaveLength(0);
});

test("debug_get_context while paused is the exact body of the request that follows", async () => {
	const call = { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "echo hi" } };
	const models = [
		{
			id: "openai/gpt-6-luna",
			name: "Luna",
			context_length: 200000,
			supported_parameters: ["reasoning", "tools"],
			top_provider: { context_length: 200000, max_completion_tokens: 32000 },
			pricing: { prompt: "0.000001", completion: "0.000008" },
		},
	];
	edupi = startEdupi({ models, responses: [{ content: [call], stopReason: "toolUse" }, "Done."] });
	await edupi.command("set_thinking_level", { level: "high" });
	await edupi.command("debug_set_step_mode", { enabled: true, breakpoints: ["beforeModelRequest"] });
	edupi.sendLine(JSON.stringify({ type: "prompt", message: "Run it." }));

	const contexts: Message[] = [];
	for (const n of [1, 2]) {
		await nth(n, isTrace("paused"));
		contexts.push((await edupi.command("debug_get_context")).data);
		await edupi.command("debug_continue");
	}
	await edupi.until("agent_settled");

	const recorded = edupi.requests().map((r) => r.body);
	expect(recorded).toHaveLength(2);
	expect(contexts.map((c) => c.body)).toEqual(recorded);
	expect(recorded[1].reasoning).toEqual({ effort: "high" }); // the thinking level is part of the body
	expect(recorded[1].messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_1" });
	for (const c of contexts) expect(c).toMatchObject({ contextWindow: 200000, autoCompactLimit: 200000 - 16384 });
});

test("debug_get_context when idle: the session's context, its token count and pi's compaction limit", async () => {
	edupi = startEdupi({ responses: ["Hello."] });
	edupi.sendLine(JSON.stringify({ type: "prompt", message: "Hi?" }));
	await edupi.until("agent_settled");
	const reply = edupi.seen.find((m) => m.type === "message_end" && m.message.role === "assistant")!.message;

	const { data } = await edupi.command("debug_get_context");
	// The next request resends everything so far: the first request's messages and the reply.
	const [first] = edupi.requests().map((r) => r.body);
	expect(data.body.messages).toEqual([...first.messages, { role: "assistant", content: "Hello." }]);
	expect(data.body.tools).toEqual(first.tools);
	expect(data).toMatchObject({
		tokens: reply.usage.totalTokens,
		contextWindow: 128000,
		autoCompactLimit: 128000 - 16384,
		messageCount: 3,
	});
});

test("debug_get_context: pi's reserveTokens setting moves the compaction limit", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "edupi-test-")));
	mkdirSync(join(dir, "home", "agent"), { recursive: true });
	writeFileSync(
		join(dir, "home", "agent", "settings.json"),
		JSON.stringify({ compaction: { reserveTokens: 100000 } }),
	);
	edupi = startEdupi({ responses: [] }, [], { dir });
	const { data } = await edupi.command("debug_get_context");
	expect(data).toMatchObject({
		body: { messages: [] },
		tokens: 0,
		contextWindow: 128000,
		autoCompactLimit: 28000,
		messageCount: 0,
	});
});
