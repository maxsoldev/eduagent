// Seam A: edupi's trace events, {type: "trace", name, ...payload} lines next to pi's RPC events.
// They show what pi hides: the exact request body, each streamed chunk and the response usage.
// The faux provider records the request bodies it got, so the trace can be checked against them.
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

const traces = (name: string) => edupi.seen.filter((m) => m.type === "trace" && m.name === name);

test("each model request is traced with its API, URL and the exact body the provider got", async () => {
	edupi = startEdupi({ responses: ["First answer.", "Second answer."] });
	await prompt("First question?");
	await prompt("Second question?");

	const recorded = edupi.requests();
	const requests = traces("modelRequest");
	expect(requests).toHaveLength(2);
	requests.forEach((r, i) => {
		expect(r).toEqual({
			type: "trace",
			name: "modelRequest",
			api: "openai-completions",
			url: recorded[i].url,
			body: recorded[i].body,
		});
	});
	expect(recorded[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
});

test("each streamed chunk is traced raw, in order, between the request and the reply's end", async () => {
	edupi = startEdupi({ responses: ["A reply streamed in chunks."] });
	await prompt("Hi?");

	const chunks = traces("streamEvent").map((m) => m.event);
	expect(chunks.length).toBeGreaterThan(2);
	for (const chunk of chunks)
		expect(chunk).toMatchObject({ id: "chatcmpl-faux", object: "chat.completion.chunk", model: "openai/gpt-6-luna" });
	expect(chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("")).toBe("A reply streamed in chunks.");
	expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason).toBe("stop");
	expect(chunks.at(-1).usage).toMatchObject({
		prompt_tokens: expect.any(Number),
		completion_tokens: expect.any(Number),
	});

	const order = edupi.seen.map((m) => (m.type === "trace" ? m.name : m.type));
	expect(order.indexOf("modelRequest")).toBeLessThan(order.indexOf("streamEvent"));
	expect(order.lastIndexOf("streamEvent")).toBeLessThan(order.indexOf("message_end", order.indexOf("modelRequest")));
});

test("each model response is traced with pi's usage, taken from the last chunk", async () => {
	edupi = startEdupi({ responses: ["Short reply."] });
	await prompt("Hi?");

	const [response] = traces("modelResponse");
	const usageChunk = traces("streamEvent")
		.map((m) => m.event)
		.find((c) => c.usage).usage;
	const reply = edupi.seen.find((m) => m.type === "message_end" && m.message.role === "assistant")!.message;
	expect(response).toEqual({
		type: "trace",
		name: "modelResponse",
		stopReason: "stop",
		responseId: "chatcmpl-faux",
		content: [{ type: "text", text: "Short reply." }],
		usage: reply.usage,
		seconds: expect.any(Number),
		cost: expect.any(Object),
	});
	expect(response.usage).toMatchObject({
		input: usageChunk.prompt_tokens,
		output: usageChunk.completion_tokens,
		totalTokens: usageChunk.prompt_tokens + usageChunk.completion_tokens,
	});
});

test("a failed model call is traced as a response with the error", async () => {
	edupi = startEdupi({ responses: [] }); // the faux provider answers HTTP 500
	await prompt("Hi?");

	expect(traces("modelRequest")).toHaveLength(1);
	const [response] = traces("modelResponse");
	expect(response).toMatchObject({
		stopReason: "error",
		errorMessage: expect.stringContaining("No more faux responses queued"),
	});
});

test("trace events still arrive after new_session, for the new session's requests", async () => {
	edupi = startEdupi({ responses: ["Old answer.", "New answer."] });
	await prompt("Old question?");
	await edupi.command("new_session");
	await prompt("New question?");

	const requests = traces("modelRequest");
	expect(requests).toHaveLength(2);
	expect(requests[1].body).toEqual(edupi.requests()[1].body);
	expect(requests[1].body.messages.map((m: Message) => m.role)).toEqual(["system", "user"]); // the new session's prompt, then its question
	expect(requests[1].body.messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "New question?" }] });
	expect(traces("modelResponse").at(-1)).toMatchObject({
		stopReason: "stop",
		content: [{ type: "text", text: "New answer." }],
	});
});

// OpenRouter's GET /models prices, in USD per token: $1 per million input tokens, $8 per million output tokens.
const PRICED = [
	{
		id: "openai/gpt-6-luna",
		name: "Luna",
		context_length: 200000,
		top_provider: { context_length: 200000, max_completion_tokens: 32000 },
		pricing: { prompt: "0.000001", completion: "0.000008", input_cache_read: "0.0000001" },
		supported_parameters: ["tools"], // pi lists only models with tool support
	},
];

test("the model's prices are traced once, from OpenRouter's model list (pi's Model.cost)", async () => {
	edupi = startEdupi({ models: PRICED, responses: ["One.", "Two."] });
	await prompt("Hi?");
	await prompt("Again?");

	expect(traces("pricing")).toEqual([
		{
			type: "trace",
			name: "pricing",
			model: "openai/gpt-6-luna",
			source: "GET /models",
			pricing: {
				model: "openai/gpt-6-luna",
				perMillionTokens: { prompt: 1, completion: 8, cache_read: 0.1, cache_write: 0 },
				longContext: null,
				longContextFromTokens: null,
			},
		},
	]);
	const order = edupi.seen.map((m) => (m.type === "trace" ? m.name : m.type));
	expect(order.indexOf("pricing")).toBeLessThan(order.indexOf("modelRequest"));
});

test("each response's cost is traced: tokens and dollars from pi's usage, and the session total", async () => {
	edupi = startEdupi({ models: PRICED, responses: ["One.", "Two."] });
	await prompt("Hi?");
	await prompt("Again?");

	const replies = edupi.seen
		.filter((m) => m.type === "message_end" && m.message.role === "assistant")
		.map((m) => m.message);
	const costs = traces("cost");
	expect(costs).toHaveLength(2);
	costs.forEach((c, i) => {
		const u = replies[i].usage;
		expect(c.last).toEqual({
			tokens: { input: u.input, uncached: u.input, cached: 0, cacheWrite: 0, output: u.output, reasoning: 0 },
			cacheHitRate: 0,
			billedUsd: null,
			usd: {
				uncachedInput: u.cost.input,
				cachedInput: 0,
				cacheWrite: 0,
				output: u.cost.output,
				total: u.cost.total,
				withoutCache: u.cost.total,
				savedByCache: 0,
			},
		});
		expect(c.last.usd.total).toBeCloseTo((u.input * 1 + u.output * 8) / 1e6, 12);
		expect(c.inputItems).toBe(edupi.requests()[i].body.messages.length);
		expect(traces("modelResponse")[i].cost).toEqual(c.last); // the Requests tab's cost table
	});
	expect(costs[1].total).toMatchObject({
		requests: 2,
		cacheHitRate: 0,
		tokens: {
			input: replies[0].usage.input + replies[1].usage.input,
			output: replies[0].usage.output + replies[1].usage.output,
		},
	});
	expect(costs[1].total.usd.total).toBeCloseTo(replies[0].usage.cost.total + replies[1].usage.cost.total, 12);
});

test("without prices (a model OpenRouter does not list), costs have tokens but no dollars", async () => {
	edupi = startEdupi({ responses: ["One."] });
	await prompt("Hi?");

	expect(traces("pricing")).toEqual([
		{ type: "trace", name: "pricing", model: "openai/gpt-6-luna", pricing: null, source: "GET /models" },
	]);
	const [cost] = traces("cost");
	expect(cost.last.tokens.output).toBeGreaterThan(0);
	expect(cost.last).not.toHaveProperty("usd");
});

test("a new session starts a new cost total", async () => {
	edupi = startEdupi({ models: PRICED, responses: ["One.", "Two."] });
	await prompt("Hi?");
	await edupi.command("new_session");
	await prompt("Again?");
	expect(traces("cost").map((c) => c.total.requests)).toEqual([1, 1]);
});

test("each loop iteration is traced after its turn_end, with the loop's decision", async () => {
	const bash = { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "echo hi" } };
	edupi = startEdupi({ responses: [{ content: [bash], stopReason: "toolUse" }, "Done."] });
	await prompt("Run echo.");

	const replies = edupi.seen
		.filter((m) => m.type === "message_end" && m.message.role === "assistant")
		.map((m) => m.message);
	expect(traces("loopIteration")).toEqual([
		{
			type: "trace",
			name: "loopIteration",
			iteration: 1,
			needsFollowUp: true,
			tokens: replies[0].usage.totalTokens,
			stopReason: "toolUse",
			decision: "continue",
		},
		{
			type: "trace",
			name: "loopIteration",
			iteration: 2,
			needsFollowUp: false,
			tokens: replies[1].usage.totalTokens,
			stopReason: "stop",
			decision: "stop",
		},
	]);
	const order = edupi.seen.map((m) => (m.type === "trace" ? m.name : m.type));
	const turnEnds = order.flatMap((name, i) => (name === "turn_end" ? [i] : []));
	const loops = order.flatMap((name, i) => (name === "loopIteration" ? [i] : []));
	expect(loops.map((i, n) => i > turnEnds[n] && i < (turnEnds[n + 1] ?? order.indexOf("agent_end")))).toEqual([
		true,
		true,
	]);
});
