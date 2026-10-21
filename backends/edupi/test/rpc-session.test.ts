// Seam A: sessions in pi's file format. edupi writes each session as a JSONL file of entries
// (id + parentId) under its home, rebuilds the context from the entries, and answers
// new_session and get_messages as pi does. The home is a temporary dir (EDUPI_CODING_AGENT_DIR).
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { type Message, type RpcClient, startEdupi } from "./rpc-client.ts";

let edupi: RpcClient;
afterEach(async () => {
	await edupi?.close();
});

function readEntries(file: string): Message[] {
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
}

async function prompt(message: string) {
	const settled = edupi.seen.filter((m) => m.type === "agent_settled").length;
	edupi.sendLine(JSON.stringify({ type: "prompt", message }));
	await edupi.until(() => edupi.seen.filter((m) => m.type === "agent_settled").length > settled);
}

const FIXTURES = new URL("./fixtures/pi/", import.meta.url).pathname;

/** Copies a session file recorded from real pi (pinned 16f5f0af4) into a fresh test dir. */
function copyFixture(name: string): { dir: string; file: string } {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "edupi-test-")));
	const file = join(dir, name);
	copyFileSync(join(FIXTURES, name), file);
	// edupi works in the header's cwd, as pi: point it at the test dir, which exists on every machine.
	const [header, ...rest] = readFileSync(file, "utf8").split("\n");
	writeFileSync(file, [JSON.stringify({ ...JSON.parse(header), cwd: dir }), ...rest].join("\n"));
	return { dir, file };
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const ENTRY_ID = /^[0-9a-f]{8}$/;

test("a prompt writes pi's session file: header, model and thinking level, then the messages", async () => {
	edupi = startEdupi({ responses: ["Hello back."] });
	const before = (await edupi.command("get_state")).data;

	// pi's path: <agentDir>/sessions/--<cwd with / as ->--/<timestamp>_<session id>.jsonl
	const sessionDir = join(edupi.dir, "home", "agent", "sessions", `--${edupi.dir.slice(1).replaceAll("/", "-")}--`);
	expect(before.sessionId).toMatch(UUID_V7);
	expect(before.sessionFile.startsWith(`${sessionDir}/`)).toBe(true);
	expect(before.sessionFile).toMatch(
		new RegExp(`/\\d{4}-\\d\\d-\\d\\dT\\d\\d-\\d\\d-\\d\\d-\\d{3}Z_${before.sessionId}\\.jsonl$`),
	);
	expect(existsSync(before.sessionFile)).toBe(false); // pi writes the file only once there is a conversation

	await prompt("Hello?");

	const entries = readEntries(before.sessionFile);
	expect(entries.map((e) => (e.type === "message" ? `message ${e.message.role}` : e.type))).toEqual([
		"session",
		"model_change",
		"thinking_level_change",
		"message system",
		"message user",
		"message assistant",
	]);
	expect(entries[0]).toEqual({
		type: "session",
		version: 3,
		id: before.sessionId,
		timestamp: expect.stringMatching(ISO),
		cwd: edupi.dir,
	});
	expect(entries[1]).toMatchObject({
		type: "model_change",
		parentId: null,
		provider: "openrouter",
		modelId: "openai/gpt-6-luna",
	});
	expect(entries[2]).toMatchObject({ type: "thinking_level_change", thinkingLevel: "off" });
	for (const [i, entry] of entries.slice(1).entries()) {
		expect(entry.id).toMatch(ENTRY_ID);
		expect(entry.timestamp).toMatch(ISO);
		expect(entry.parentId).toBe(i === 0 ? null : entries[i].id); // one linear branch: each entry's parent is the one before
	}
	expect(entries[3].message).toMatchObject({ role: "system", content: "", toolsAdded: expect.any(Array) });
	expect(entries[4].message).toEqual({
		role: "user",
		content: [{ type: "text", text: "Hello?" }],
		timestamp: expect.any(Number),
	});
	expect(entries[5].message).toMatchObject({
		role: "assistant",
		content: [{ type: "text", text: "Hello back." }],
		stopReason: "stop",
	});
});

test("get_messages returns the session's messages, as get_state counts them", async () => {
	edupi = startEdupi({ responses: ["First answer.", "Second answer."] });
	expect(await edupi.command("get_messages")).toEqual({
		id: "1",
		type: "response",
		command: "get_messages",
		success: true,
		data: { messages: [] },
	});

	await prompt("One?");
	await prompt("Two?");

	const { data } = await edupi.command("get_messages");
	// The tools are declared once, in a system message before the first prompt.
	expect(data.messages.map((m: Message) => m.role)).toEqual(["system", "user", "assistant", "user", "assistant"]);
	expect(data.messages[3]).toEqual({
		role: "user",
		content: [{ type: "text", text: "Two?" }],
		timestamp: expect.any(Number),
	});
	expect(data.messages[4]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "Second answer." }] });
	expect((await edupi.command("get_state")).data.messageCount).toBe(5);
});

test("new_session starts a fresh session in a new file; the old file stays as it was", async () => {
	edupi = startEdupi({ responses: ["Old answer.", "New answer."] });
	await prompt("Old question?");
	const old = (await edupi.command("get_state")).data;
	const oldFile = readFileSync(old.sessionFile, "utf8");

	const reply = await edupi.command("new_session");
	expect(reply).toEqual({
		id: "2",
		type: "response",
		command: "new_session",
		success: true,
		data: { cancelled: false },
	});

	const fresh = (await edupi.command("get_state")).data;
	expect(fresh.sessionId).toMatch(UUID_V7);
	expect(fresh.sessionId).not.toBe(old.sessionId);
	expect(fresh.sessionFile).not.toBe(old.sessionFile);
	expect(fresh.messageCount).toBe(0);
	expect((await edupi.command("get_messages")).data.messages).toEqual([]);

	// The new session's events still reach stdout, and its first request has no old messages.
	await prompt("New question?");
	const lastBody = edupi.requests().at(-1)!.body;
	expect(lastBody.messages.map((m: Message) => m.role)).toEqual(["system", "user"]);
	expect(lastBody.messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "New question?" }] });

	expect(readFileSync(old.sessionFile, "utf8")).toBe(oldFile);
	const entries = readEntries(fresh.sessionFile);
	expect(entries[0]).toMatchObject({ type: "session", id: fresh.sessionId });
	expect(entries.filter((e) => e.type === "message").map((e) => e.message.content[0]?.text ?? e.message.role)).toEqual(
		["system", "New question?", "New answer."],
	); // the new session declares the tools again
	expect(readdirSync(join(old.sessionFile, ".."))).toHaveLength(2);
});

test("--session opens a session file written by real pi and rebuilds its messages", async () => {
	const { dir, file } = copyFixture("session-prompt-and-tools.jsonl");
	const recorded = readEntries(file);
	edupi = startEdupi({ responses: ["Hello again."] }, ["--session", file], { dir });

	const state = (await edupi.command("get_state")).data;
	expect(state).toMatchObject({ sessionId: recorded[0].id, sessionFile: file, messageCount: 8 });
	// pi recorded thinking level "medium"; edupi's default model has no reasoning, so pi's clamp makes it "off".
	expect(state.thinkingLevel).toBe("off");

	// Every message entry, in file order: the system prompt, two prompts, two tool results, three replies.
	const { messages } = (await edupi.command("get_messages")).data;
	expect(messages.map((m: Message) => m.role)).toEqual([
		"system",
		"user",
		"assistant",
		"user",
		"assistant",
		"toolResult",
		"toolResult",
		"assistant",
	]);
	expect(messages).toEqual(recorded.filter((e) => e.type === "message").map((e) => e.message));
	expect(messages[4].content.map((b: Message) => b.name)).toEqual(["bash", "read"]);
	expect(messages[7].content).toEqual([{ type: "text", text: "Done." }]);

	// A new prompt continues the session: the request carries the old conversation, and the
	// new entries are appended to pi's file, children of its last entry.
	await prompt("Still there?");
	const body = edupi.requests()[0].body;
	expect(body.messages[0].content).toMatch(/^You are an expert coding assistant operating inside pi/);
	expect(body.messages.slice(1, 3)).toEqual([
		{ role: "user", content: [{ type: "text", text: "say hi" }] },
		{ role: "assistant", content: "Hello from fake." },
	]);
	expect(body.messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "Still there?" }] });

	const after = readEntries(file);
	expect(after.slice(0, recorded.length)).toEqual(recorded);
	const added = after.slice(recorded.length);
	// pi's file already has a thinking level entry. edupi's prompt differs from the one in the file
	// (no <docs>, another cwd), so a system message patches those sections first, as pi does.
	expect(added.map((e) => e.message.role)).toEqual(["system", "user", "assistant"]);
	expect(added[0].message.sections).toEqual({ docs: null, cwd: `<cwd>\n${dir}\n</cwd>` });
	expect(added[0].parentId).toBe(recorded.at(-1)!.id);
	expect(added[1].parentId).toBe(added[0].id);
	expect(added[2].parentId).toBe(added[1].id);
});

test("a pi session with compactions is rebuilt from the latest compaction and the kept messages", async () => {
	const { dir, file } = copyFixture("session-compact.jsonl");
	const recorded = readEntries(file);
	const latest = recorded.filter((e) => e.type === "compaction").at(-1)!;
	edupi = startEdupi({ responses: ["Fifth."] }, ["--session", file], { dir });

	// The file has two compactions. Only the second counts: its system message and summary, the
	// messages from its firstKeptEntryId on (the first compaction there adds nothing), then the rest.
	const { messages } = (await edupi.command("get_messages")).data;
	expect(messages.map((m: Message) => m.role)).toEqual([
		"system",
		"compactionSummary",
		"assistant",
		"user",
		"assistant",
		"user",
		"assistant",
	]);
	expect(messages[1]).toEqual({
		role: "compactionSummary",
		summary: "## Goal\nSECOND SUMMARY\n\n---\n\n**Turn Context (split turn):**\n\nFourth.",
		tokensBefore: latest.tokensBefore,
		timestamp: Date.parse(latest.timestamp),
	});
	expect(messages.slice(2).map((m: Message) => m.content[0].text)).toEqual([
		"Second answer with some words.",
		"q3",
		"Third answer.",
		"q4",
		"Fourth.",
	]);

	// The next request is the one real pi sent for q4, plus q4's answer and the new prompt. The
	// summary goes to the model as a user message. (pi's model had reasoning, so its system
	// prompt went as "developer"; edupi's default model has none, so it goes as "system".) The
	// prompt itself is pi's, patched by edupi: no <docs> section, and this test's cwd.
	await prompt("q5");
	const pi = JSON.parse(readFileSync(join(FIXTURES, "session-compact.q4-request.json"), "utf8")).messages;
	expect(pi[1].content[0].text).toMatch(
		/^The conversation history before this point was compacted into the following summary:\n\n<summary>\n## Goal\nSECOND SUMMARY/,
	);
	expect(edupi.requests()[0].body.messages).toEqual([
		{
			role: "system",
			content: pi[0].content
				.replace(/\n\n<docs>[\s\S]*<\/docs>/, "")
				.replace(readEntries(join(FIXTURES, "session-compact.jsonl"))[0].cwd, dir),
		},
		...pi.slice(1),
		{ role: "assistant", content: "Fourth." },
		{ role: "user", content: [{ type: "text", text: "q5" }] },
	]);
});

test("--continue reopens the newest session of the working directory", async () => {
	edupi = startEdupi({ responses: ["Remembered."] });
	await prompt("Remember this.");
	const first = (await edupi.command("get_state")).data;
	await edupi.close();

	edupi = startEdupi({ responses: ["Yes."] }, ["--continue"], { dir: edupi.dir });
	const state = (await edupi.command("get_state")).data;
	expect(state).toMatchObject({ sessionId: first.sessionId, sessionFile: first.sessionFile, messageCount: 3 });
	await prompt("Do you remember?");
	expect(
		edupi
			.requests()
			.at(-1)!
			.body.messages.map((m: Message) => m.role),
	).toEqual(["system", "user", "assistant", "user"]);
});

test("--no-session keeps the session in memory and writes no file", async () => {
	edupi = startEdupi({ responses: ["Hi."] }, ["--no-session"]);
	await prompt("Hello?");
	const state = (await edupi.command("get_state")).data;
	expect(state.sessionFile).toBeUndefined();
	expect(state.messageCount).toBe(3); // system (tools), user, assistant
	expect(existsSync(join(edupi.dir, "home", "agent", "sessions"))).toBe(false);
});

test("--session on an empty file writes a header into it, then appends the conversation", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "edupi-test-")));
	const file = join(dir, "empty.jsonl");
	writeFileSync(file, "");
	edupi = startEdupi({ responses: ["Hi."] }, ["--session", file], { dir });
	const state = (await edupi.command("get_state")).data;
	expect(state.sessionFile).toBe(file);
	// pi writes the header at once and counts the file as written, so the settings follow before any prompt.
	expect(readEntries(file).map((e) => e.type)).toEqual(["session", "model_change", "thinking_level_change"]);

	await prompt("Hello?");
	const entries = readEntries(file);
	expect(entries[0]).toMatchObject({ type: "session", id: state.sessionId });
	expect(entries.filter((e) => e.type === "message").map((e) => e.message.role)).toEqual([
		"system",
		"user",
		"assistant",
	]);
});

test("--session on a file without a final newline adds one before it appends", async () => {
	const { dir, file } = copyFixture("session-prompt-and-tools.jsonl");
	writeFileSync(file, readFileSync(file, "utf8").trimEnd()); // e.g. a crash during the last write
	const recorded = readEntries(file);
	edupi = startEdupi({ responses: ["Hello again."] }, ["--session", file], { dir });
	await prompt("Still there?");
	const after = readEntries(file);
	expect(after.slice(0, recorded.length)).toEqual(recorded);
	expect(after.slice(recorded.length).map((e) => e.message.role)).toEqual(["system", "user", "assistant"]);
});

test("--session refuses a file whose first entry is not a session header, and leaves it as it was", async () => {
	const { dir, file } = copyFixture("session-prompt-and-tools.jsonl");
	const [header, ...rest] = readFileSync(file, "utf8").trimEnd().split("\n");
	const content = `${[...rest, header].join("\n")}\n`;
	writeFileSync(file, content);
	edupi = startEdupi({ responses: [] }, ["--session", file], { dir });
	expect(await edupi.close()).not.toBe(0);
	expect(edupi.stderrText).toContain(`Session file is not a valid edupi session: ${file}`);
	expect(readFileSync(file, "utf8")).toBe(content);
});

test("--continue skips a newer file in the session folder that is not a session", async () => {
	edupi = startEdupi({ responses: ["Remembered."] });
	await prompt("Remember this.");
	const first = (await edupi.command("get_state")).data;
	await edupi.close();
	const junk = join(first.sessionFile, "..", "zz-notes.jsonl");
	writeFileSync(junk, '{"note":"not a session"}\n');
	utimesSync(junk, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));

	edupi = startEdupi({ responses: [] }, ["--continue"], { dir: edupi.dir });
	const state = (await edupi.command("get_state")).data;
	expect(state).toMatchObject({ sessionId: first.sessionId, sessionFile: first.sessionFile });
});

test("a message saved with null content is read as empty content, as pi reads hand-edited files", async () => {
	const { dir, file } = copyFixture("session-prompt-and-tools.jsonl");
	const entries = readEntries(file);
	const messageEntries = entries.filter((e) => e.type === "message");
	messageEntries[0].message.content = null; // the system message
	messageEntries[2].message.content = null; // the first assistant reply
	writeFileSync(file, entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
	edupi = startEdupi({ responses: ["Hello again."] }, ["--session", file], { dir });

	const { messages } = (await edupi.command("get_messages")).data;
	expect(messages[0].content).toBe("");
	expect(messages[2].content).toEqual([]);
	await prompt("Still there?");
	expect(edupi.requests()).toHaveLength(1);
});
