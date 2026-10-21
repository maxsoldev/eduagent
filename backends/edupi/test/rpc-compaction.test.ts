// Seam A: compaction. edupi summarises the older messages with pi's prompts, writes the summary
// as a compaction entry, and rebuilds the next request from that entry and the kept messages.
// It compacts by hand (`compact`), at the threshold (context window minus reserve tokens) and
// after a context overflow (then it retries). Settings come from <home>/settings.json, as in pi.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { type Message, type RpcClient, startEdupi } from "./rpc-client.ts";

let edupi: RpcClient;
afterEach(async () => {
	await edupi?.close();
});

const FIXTURES = new URL("./fixtures/pi/", import.meta.url).pathname;

/** A test dir whose edupi home has this settings.json (and this SYSTEM.md, if given). */
function dirWithSettings(settings: object, systemPrompt?: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "edupi-test-")));
	mkdirSync(join(dir, "home", "agent"), { recursive: true });
	writeFileSync(join(dir, "home", "agent", "settings.json"), JSON.stringify(settings));
	if (systemPrompt) writeFileSync(join(dir, "home", "agent", "SYSTEM.md"), systemPrompt);
	return dir;
}

/** The threshold tests use a tiny context window. A one-line SYSTEM.md (it replaces pi's preamble, tools and rules) keeps the prompt small. */
const SHORT_PROMPT = "Be brief.";

async function prompt(message: string) {
	const settled = edupi.seen.filter((m) => m.type === "agent_settled").length;
	edupi.sendLine(JSON.stringify({ type: "prompt", message }));
	await edupi.until(() => edupi.seen.filter((m) => m.type === "agent_settled").length > settled);
}

function entries(): Message[] {
	const file = edupi.seen.find((m) => m.command === "get_state")?.data.sessionFile;
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
}

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const summaryMessage = (summary: string) =>
	user(
		`The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`,
	);

test("manual compaction with custom instructions: pi's events, prompt and compaction entry; the next request starts from it", async () => {
	// keepRecentTokens 9 keeps "q2" and its answer (1 + 8 estimated tokens); q1 and its answer are summarised.
	edupi = startEdupi(
		{
			responses: [
				"First answer with some words.",
				"Second answer with some words.",
				"## Goal\nFIRST SUMMARY",
				"Third answer.",
			],
		},
		[],
		{ dir: dirWithSettings({ compaction: { keepRecentTokens: 9 } }) },
	);
	await edupi.command("get_state");
	await prompt("q1");
	await prompt("q2");
	const lastUsage = edupi.seen.filter((m) => m.type === "message_end").at(-1)!.message.usage;

	const seenBefore = edupi.seen.length;
	const response = await edupi.command("compact", { customInstructions: "Keep the file names." });
	const during = edupi.seen.slice(seenBefore).filter((m) => m.type !== "trace");
	const result = {
		summary: "## Goal\nFIRST SUMMARY",
		firstKeptEntryId: expect.stringMatching(/^[0-9a-f]{8}$/),
		tokensBefore: lastUsage.totalTokens, // the last reported usage, nothing estimated after it
		estimatedTokensAfter: expect.any(Number),
		usage: expect.objectContaining({ input: expect.any(Number), output: expect.any(Number) }),
		details: { readFiles: [], modifiedFiles: [] },
	};
	// No message events for the summary call: it is not part of the conversation.
	expect(during).toEqual([
		{ type: "compaction_start", reason: "manual" },
		{ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false },
		{ id: "2", type: "response", command: "compact", success: true, data: result },
	]);

	// The summary request: pi's summarization system prompt, then one user message with the
	// serialised conversation, the first-compaction prompt and the custom instructions.
	const summaryRequest = edupi.requests()[2].body;
	expect(summaryRequest.messages).toHaveLength(2);
	expect(summaryRequest.messages[0]).toEqual({
		role: "system",
		content: expect.stringMatching(/^You are a context summarization assistant\./),
	});
	const text: string = summaryRequest.messages[1].content[0].text;
	expect(
		text.startsWith(
			"<conversation>\n[User]: q1\n\n[Assistant]: First answer with some words.\n</conversation>\n\n" +
				"The messages above are a conversation to summarize. Create a structured context checkpoint summary",
		),
	).toBe(true);
	expect(
		text.endsWith(
			"Preserve exact file paths, function names, and error messages.\n\nAdditional focus: Keep the file names.",
		),
	).toBe(true);
	expect(text).not.toContain("<previous-summary>");

	// The compaction entry: a child of the last message; it points at the first kept entry (q2).
	const file = entries();
	const compaction = file.at(-1)!;
	const q2 = file.find((e) => e.type === "message" && e.message.content[0]?.text === "q2")!;
	expect(compaction).toEqual({
		type: "compaction",
		id: expect.any(String),
		parentId: file.at(-2)!.id,
		timestamp: expect.any(String),
		summary: "## Goal\nFIRST SUMMARY",
		firstKeptEntryId: q2.id,
		tokensBefore: lastUsage.totalTokens,
		details: { readFiles: [], modifiedFiles: [] },
		usage: expect.any(Object),
		// The current system message: the prompt's sections and pi's tools, replayed from the transcript.
		systemMessage: {
			role: "system",
			content: "",
			sections: expect.objectContaining({ preamble: expect.any(String), cwd: expect.any(String) }),
			toolsAdded: expect.any(Array),
			timestamp: expect.any(Number),
		},
	});
	expect(response.data.firstKeptEntryId).toBe(q2.id);

	// The next request: the system prompt (from the entry's system message), the summary as a user
	// message, then the kept messages, then the new prompt.
	await prompt("q3");
	expect(edupi.requests()[3].body.messages).toEqual([
		edupi.requests()[0].body.messages[0],
		summaryMessage("## Goal\nFIRST SUMMARY"),
		user("q2"),
		{ role: "assistant", content: "Second answer with some words." },
		user("q3"),
	]);
	const { messages } = (await edupi.command("get_messages")).data;
	expect(messages.map((m: Message) => m.role)).toEqual([
		"system",
		"compactionSummary",
		"user",
		"assistant",
		"user",
		"assistant",
	]);
});

test("compaction follows real pi: a split turn, then the update prompt with the previous summary", async () => {
	// The same settings, prompts and replies as the session real pi wrote (fixtures/pi/session-compact.jsonl).
	// The model reasons, as pi's did, so the summarization prompt goes as "developer".
	const models = [
		{
			id: "openai/gpt-6-luna",
			name: "OpenAI: GPT-6 Luna",
			context_length: 400000,
			top_provider: { context_length: 272000, max_completion_tokens: 128000 },
			supported_parameters: ["tools", "reasoning"],
		},
	];
	edupi = startEdupi(
		{
			models,
			responses: [
				"First answer with some words.",
				"Second answer with some words.",
				"## Goal\nFIRST SUMMARY",
				"Third answer.",
				"## Goal\nSECOND SUMMARY",
				"Fourth.",
				"Fourth.",
			],
		},
		[],
		{ dir: dirWithSettings({ compaction: { keepRecentTokens: 10 } }) },
	);
	const dir = edupi.dir;
	await edupi.command("get_state");
	await prompt("q1");
	await prompt("q2");
	await edupi.command("compact", { customInstructions: "Keep the file names." });
	await prompt("q3");
	const second = await edupi.command("compact");
	await prompt("q4");

	// The three summary requests are the ones real pi sent: the first compaction cuts inside the
	// q1 turn, so pi summarises only that turn's prefix (custom instructions go only into a history
	// summary). The second one updates the first summary and summarises the new split turn.
	const pi = JSON.parse(readFileSync(join(FIXTURES, "session-compact.summary-requests.json"), "utf8")).requests;
	const requests = edupi.requests().map((r) => r.body.messages);
	expect([requests[2], requests[4], requests[5]]).toEqual(pi);
	// Every request, the summary requests too, carries the session's thinking level (pi's default medium), as in pi's.
	expect(edupi.requests().map((r) => r.body.reasoning)).toEqual(Array(7).fill({ effort: "medium" }));
	expect(pi[1][1].content[0].text).toContain(
		"<previous-summary>\nNo prior history.\n\n---\n\n**Turn Context (split turn):**\n\n## Goal\nFIRST SUMMARY\n</previous-summary>",
	);
	expect(second.data.summary).toBe("## Goal\nSECOND SUMMARY\n\n---\n\n**Turn Context (split turn):**\n\nFourth.");

	// The compaction entries match pi's: same summaries, and each keeps from the same message.
	const piEntries: Message[] = readFileSync(join(FIXTURES, "session-compact.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
	const keptText = (file: Message[], c: Message) =>
		file.find((e) => e.id === c.firstKeptEntryId)!.message.content[0].text;
	const ours = entries();
	const summarize = (file: Message[]) =>
		file.filter((e) => e.type === "compaction").map((c) => ({ summary: c.summary, kept: keptText(file, c) }));
	expect(summarize(ours)).toEqual(summarize(piEntries));
	expect(summarize(ours).map((c) => c.kept)).toEqual([
		"First answer with some words.",
		"Second answer with some words.",
	]);

	// The q4 request is pi's. Only the system prompt differs: edupi has no <docs> section, and its cwd is this test's.
	const q4 = JSON.parse(readFileSync(join(FIXTURES, "session-compact.q4-request.json"), "utf8")).messages;
	expect(requests[6]).toEqual([
		{
			role: "developer",
			content: q4[0].content.replace(/\n\n<docs>[\s\S]*<\/docs>/, "").replace(piEntries[0].cwd, dir),
		},
		...q4.slice(1),
	]);
});

test("compact on a session with nothing to summarise ends with pi's error", async () => {
	edupi = startEdupi({ responses: [] });
	const response = await edupi.command("compact");
	expect(edupi.seen.filter((m) => m.type !== "trace")).toEqual([
		{ type: "compaction_start", reason: "manual" },
		{
			type: "compaction_end",
			reason: "manual",
			aborted: false,
			willRetry: false,
			errorMessage: "Compaction failed: Nothing to compact (session too small)",
		},
		response,
	]);
	expect(response).toEqual({
		id: "1",
		type: "response",
		command: "compact",
		success: false,
		error: "Nothing to compact (session too small)",
	});
});

/** A model with a tiny context window, as OpenRouter's GET /models would list it. */
const tinyModel = (contextLength: number) => [
	{
		id: "openai/gpt-6-luna",
		name: "Tiny Luna",
		context_length: contextLength,
		top_provider: { context_length: contextLength, max_completion_tokens: 50 },
		supported_parameters: ["tools"],
	},
];

test("threshold: after a run whose context passed contextWindow - reserveTokens, edupi compacts before agent_settled", async () => {
	const long = "x".repeat(400); // 100 estimated tokens
	// Window 200, reserve 100: compact above 100 tokens. keepRecentTokens 101 keeps q2 (1) and its answer (100).
	edupi = startEdupi(
		{ models: tinyModel(200), responses: ["First answer.", long, "## Goal\nTHRESHOLD SUMMARY", "Third answer."] },
		[],
		{ dir: dirWithSettings({ compaction: { reserveTokens: 100, keepRecentTokens: 101 } }, SHORT_PROMPT) },
	);
	await edupi.command("get_state");
	await prompt("q1");
	expect(edupi.seen.some((m) => m.type === "compaction_start")).toBe(false); // a few dozen tokens: below the threshold

	const start = edupi.seen.length;
	await prompt("q2");
	const reply = edupi.seen.filter((m) => m.type === "message_end").at(-1)!.message;
	expect(reply.usage.totalTokens).toBeGreaterThan(100);
	const after = edupi.seen
		.slice(start)
		.filter((m) => m.type !== "trace" && m.type !== "message_update")
		.map((m) => m.type);
	expect(after.slice(-4)).toEqual(["agent_end", "compaction_start", "compaction_end", "agent_settled"]);
	const end = edupi.seen.find((m) => m.type === "compaction_end")!;
	expect(edupi.seen.find((m) => m.type === "compaction_start")).toEqual({
		type: "compaction_start",
		reason: "threshold",
	});
	expect(end).toMatchObject({
		reason: "threshold",
		aborted: false,
		willRetry: false,
		result: { summary: "## Goal\nTHRESHOLD SUMMARY", tokensBefore: reply.usage.totalTokens },
	});
	expect(edupi.requests()[2].body.messages[1].content[0].text).toMatch(
		/^<conversation>\n\[User\]: q1\n\n\[Assistant\]: First answer\.\n<\/conversation>/,
	);

	// No retry: the run ended with the reply. The next prompt starts from the compaction (the old
	// reply's usage predates it, so the check before the prompt does not compact again).
	await prompt("q3");
	expect(edupi.requests()[3].body.messages).toEqual([
		edupi.requests()[0].body.messages[0],
		summaryMessage("## Goal\nTHRESHOLD SUMMARY"),
		user("q2"),
		{ role: "assistant", content: long },
		user("q3"),
	]);
});

const OVERFLOW = {
	error: {
		status: 400,
		message: "This endpoint's maximum context length is 1000 tokens. However, you requested about 5000 tokens.",
	},
};

test("overflow: the provider refuses the context; edupi drops the failed reply, compacts and retries once", async () => {
	// keepRecentTokens 1 keeps only the last prompt; everything before it is summarised.
	edupi = startEdupi(
		{
			responses: [
				"First answer.",
				"Second answer.",
				OVERFLOW,
				"## Goal\nOVERFLOW SUMMARY",
				"Third answer, after the retry.",
			],
		},
		[],
		{ dir: dirWithSettings({ compaction: { keepRecentTokens: 1 } }) },
	);
	await edupi.command("get_state");
	await prompt("q1");
	await prompt("q2");
	const start = edupi.seen.length;
	await prompt("q3");
	const events = edupi.seen.slice(start).filter((m) => m.type !== "trace" && m.type !== "message_update");

	// The failed run ends, then pi's recovery: omit the reply, compact, and a second run continues.
	expect(events.map((m) => (m.type === "message_end" ? `message_end ${m.message.role}` : m.type))).toEqual([
		"response",
		"agent_start",
		"turn_start",
		"message_start",
		"message_end user",
		"message_start",
		"message_end assistant",
		"turn_end",
		"agent_end",
		"entry_appended",
		"compaction_start",
		"compaction_end",
		"agent_start",
		"turn_start",
		"message_start",
		"message_end assistant",
		"turn_end",
		"agent_end",
		"agent_settled",
	]);
	const failed = events.find((m) => m.type === "message_end" && m.message.role === "assistant")!.message;
	expect(failed).toMatchObject({
		stopReason: "error",
		errorMessage: expect.stringMatching(/maximum context length is 1000 tokens/),
	});
	expect(events.find((m) => m.type === "compaction_start")).toEqual({ type: "compaction_start", reason: "overflow" });
	expect(events.find((m) => m.type === "compaction_end")).toMatchObject({
		reason: "overflow",
		aborted: false,
		willRetry: true,
		result: { summary: "## Goal\nOVERFLOW SUMMARY" },
	});
	expect(events.at(-3)).toMatchObject({
		type: "turn_end",
		message: { stopReason: "stop", content: [{ type: "text", text: "Third answer, after the retry." }] },
	});

	// The retry is rebuilt from the compaction: the summary, then q3. The failed reply is not in it.
	const requests = edupi.requests().map((r) => r.body.messages);
	expect(requests[3][1].content[0].text).toMatch(
		/^<conversation>\n\[User\]: q1\n\n\[Assistant\]: First answer\.\n\n\[User\]: q2\n\n\[Assistant\]: Second answer\.\n<\/conversation>/,
	);
	expect(requests[4]).toEqual([requests[0][0], summaryMessage("## Goal\nOVERFLOW SUMMARY"), user("q3")]);

	// The session file keeps the failed reply; a context_edit entry leaves it out of the context.
	const file = entries();
	const failedEntry = file.find((e) => e.type === "message" && e.message.stopReason === "error")!;
	const edit = file.find((e) => e.type === "context_edit")!;
	expect(edit).toEqual({
		type: "context_edit",
		id: expect.any(String),
		parentId: failedEntry.id,
		timestamp: expect.any(String),
		targetId: failedEntry.id,
		replacement: null,
	});
	expect(events.find((m) => m.type === "entry_appended")!.entry).toEqual(edit);
	expect(file.map((e) => e.type).slice(-3)).toEqual(["context_edit", "compaction", "message"]);
	const { messages } = (await edupi.command("get_messages")).data;
	expect(messages.map((m: Message) => m.role)).toEqual(["system", "compactionSummary", "user", "assistant"]);
});

test("overflow: a second overflow after the retry gives up with pi's error", async () => {
	edupi = startEdupi({ responses: ["First answer.", OVERFLOW, "## Goal\nOVERFLOW SUMMARY", OVERFLOW] }, [], {
		dir: dirWithSettings({ compaction: { keepRecentTokens: 1 } }),
	});
	await prompt("q1");
	await prompt("q2");
	const ends = edupi.seen.filter((m) => m.type === "compaction_end");
	expect(ends.map((e) => [e.willRetry, e.errorMessage])).toEqual([
		[true, undefined],
		[
			false,
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		],
	]);
	expect(edupi.seen.filter((m) => m.type === "agent_start")).toHaveLength(3); // q1, q2, the one retry
	expect(edupi.seen.at(-1)).toEqual({ type: "agent_settled", aborted: false });
});

test("trace events show the summary request body and the context rebuilt from the compaction", async () => {
	edupi = startEdupi({ responses: ["First answer.", "## Goal\nTRACED SUMMARY"] }, [], {
		dir: dirWithSettings({ compaction: { keepRecentTokens: 1 } }),
	});
	await prompt("q1");
	await edupi.command("compact");
	const names = edupi.seen
		.filter(
			(m) =>
				m.type === "compaction_start" ||
				m.type === "compaction_end" ||
				(m.type === "trace" && m.name !== "streamEvent"),
		)
		.slice(-7)
		.map((m) => m.name ?? m.type);
	// The summary request costs money too: its cost follows its response.
	expect(names).toEqual([
		"compaction_start",
		"compactionRequest",
		"modelRequest",
		"modelResponse",
		"cost",
		"compacted",
		"compaction_end",
	]);

	const request = edupi.seen.find((m) => m.name === "compactionRequest")!;
	const end = edupi.seen.find((m) => m.type === "compaction_end")!;
	expect(request).toEqual({
		type: "trace",
		name: "compactionRequest",
		reason: "manual",
		tokensBefore: end.result.tokensBefore,
		body: edupi.requests()[1].body,
	});
	const compacted = edupi.seen.find((m) => m.name === "compacted")!;
	const { messages } = (await edupi.command("get_messages")).data;
	expect(compacted).toEqual({
		type: "trace",
		name: "compacted",
		reason: "manual",
		summary: end.result.summary,
		firstKeptEntryId: end.result.firstKeptEntryId,
		tokensBefore: end.result.tokensBefore,
		tokensAfter: end.result.estimatedTokensAfter,
		details: { readFiles: [], modifiedFiles: [] },
		messages,
	});
});

test("threshold inside a run: after tool results fill the context, edupi compacts before the next model call", async () => {
	const bash = { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "printf '%400s' | tr ' ' x" } }; // 400 characters of output
	// Window 200, reserve 100: compact above 100 tokens. The tool result alone is estimated at 100.
	edupi = startEdupi(
		{
			models: tinyModel(200),
			responses: [
				"First answer.",
				{ content: [bash], stopReason: "toolUse" },
				"## Goal\nHISTORY",
				"## Original Request\nPREFIX",
				"Done.",
				"## Goal\nAFTER",
				"## Original Request\nAFTER",
			],
		},
		[],
		{ dir: dirWithSettings({ compaction: { reserveTokens: 100, keepRecentTokens: 50 } }, SHORT_PROMPT) },
	);
	await edupi.command("get_state");
	await prompt("q1");
	const start = edupi.seen.length;
	await prompt("q2");
	const events = edupi.seen.slice(start).filter((m) => m.type !== "trace" && m.type !== "message_update");
	const types = events.map((m) => (m.type === "message_end" ? `message_end ${m.message.role}` : m.type));

	// One run: the tool turn ends, the session compacts, then the next turn starts from the compaction.
	const firstCompaction = types.indexOf("compaction_start");
	expect(types.slice(firstCompaction - 2, firstCompaction + 3)).toEqual([
		"message_end toolResult",
		"turn_end",
		"compaction_start",
		"compaction_end",
		"turn_start",
	]);
	expect(events[firstCompaction]).toEqual({ type: "compaction_start", reason: "threshold" });
	expect(types.filter((t) => t === "agent_start")).toHaveLength(1);

	// The model call after it: the prompt, the summary, then the kept tool call and its result (no q1, no first answer).
	const afterCompaction = edupi.requests()[4].body.messages;
	expect(afterCompaction[0]).toEqual({ role: "system", content: `Be brief.\n\n<cwd>\n${edupi.dir}\n</cwd>` });
	expect(afterCompaction[1].content[0].text).toMatch(/^The conversation history before this point was compacted/);
	expect(afterCompaction.map((m: Message) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
	expect(afterCompaction[3].content).toBe("x".repeat(400));
});
