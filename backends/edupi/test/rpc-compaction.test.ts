// Seam A: compaction. edupi summarises the older messages with pi's prompts, writes the summary
// as a compaction entry, and rebuilds the next request from that entry and the kept messages.
// It compacts by hand (`compact`), at the threshold (context window minus reserve tokens) and
// after a context overflow (then it retries). Settings come from <home>/settings.json, as in pi.
import { mkdirSync, readFileSync, realpathSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { startEdupi, type Message, type RpcClient } from "./rpc-client.ts";

let edupi: RpcClient;
afterEach(async () => {
  await edupi?.close();
});

const FIXTURES = new URL("./fixtures/pi/", import.meta.url).pathname;

/** A test dir whose edupi home has this settings.json. */
function dirWithSettings(settings: object): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "edupi-test-")));
  mkdirSync(join(dir, "home", "agent"), { recursive: true });
  writeFileSync(join(dir, "home", "agent", "settings.json"), JSON.stringify(settings));
  return dir;
}

async function prompt(message: string) {
  const settled = edupi.seen.filter((m) => m.type === "agent_settled").length;
  edupi.sendLine(JSON.stringify({ type: "prompt", message }));
  await edupi.until(() => edupi.seen.filter((m) => m.type === "agent_settled").length > settled);
}

function entries(): Message[] {
  const file = edupi.seen.find((m) => m.command === "get_state")?.data.sessionFile;
  return readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const summaryMessage = (summary: string) =>
  user(`The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`);

test("manual compaction with custom instructions: pi's events, prompt and compaction entry; the next request starts from it", async () => {
  // keepRecentTokens 9 keeps "q2" and its answer (1 + 8 estimated tokens); q1 and its answer are summarised.
  edupi = startEdupi({ responses: ["First answer with some words.", "Second answer with some words.", "## Goal\nFIRST SUMMARY", "Third answer."] },
    [], { dir: dirWithSettings({ compaction: { keepRecentTokens: 9 } }) });
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
  expect(summaryRequest.messages[0]).toEqual({ role: "system", content: expect.stringMatching(/^You are a context summarization assistant\./) });
  const text: string = summaryRequest.messages[1].content[0].text;
  expect(text.startsWith("<conversation>\n[User]: q1\n\n[Assistant]: First answer with some words.\n</conversation>\n\n" +
    "The messages above are a conversation to summarize. Create a structured context checkpoint summary")).toBe(true);
  expect(text.endsWith("Preserve exact file paths, function names, and error messages.\n\nAdditional focus: Keep the file names.")).toBe(true);
  expect(text).not.toContain("<previous-summary>");

  // The compaction entry: a child of the last message; it points at the first kept entry (q2).
  const file = entries();
  const compaction = file.at(-1)!;
  const q2 = file.find((e) => e.type === "message" && e.message.content[0]?.text === "q2")!;
  expect(compaction).toEqual({
    type: "compaction", id: expect.any(String), parentId: file.at(-2)!.id, timestamp: expect.any(String),
    summary: "## Goal\nFIRST SUMMARY", firstKeptEntryId: q2.id, tokensBefore: lastUsage.totalTokens,
    details: { readFiles: [], modifiedFiles: [] }, usage: expect.any(Object),
  });
  expect(response.data.firstKeptEntryId).toBe(q2.id);

  // The next request: the summary as a user message, then the kept messages, then the new prompt.
  await prompt("q3");
  expect(edupi.requests()[3].body.messages).toEqual([
    summaryMessage("## Goal\nFIRST SUMMARY"),
    user("q2"),
    { role: "assistant", content: "Second answer with some words." },
    user("q3"),
  ]);
  const { messages } = (await edupi.command("get_messages")).data;
  expect(messages.map((m: Message) => m.role)).toEqual(["compactionSummary", "user", "assistant", "user", "assistant"]);
});

test("compaction follows real pi: a split turn, then the update prompt with the previous summary", async () => {
  // The same settings, prompts and replies as the session real pi wrote (fixtures/pi/session-compact.jsonl).
  // The model reasons, as pi's did, so the summarization prompt goes as "developer".
  const models = [{ id: "openai/gpt-6-luna", name: "OpenAI: GPT-6 Luna", context_length: 400000,
    top_provider: { context_length: 272000, max_completion_tokens: 128000 }, supported_parameters: ["tools", "reasoning"] }];
  edupi = startEdupi({ models, responses: ["First answer with some words.", "Second answer with some words.", "## Goal\nFIRST SUMMARY",
    "Third answer.", "## Goal\nSECOND SUMMARY", "Fourth.", "Fourth."] }, [], { dir: dirWithSettings({ compaction: { keepRecentTokens: 10 } }) });
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
  expect(pi[1][1].content[0].text).toContain("<previous-summary>\nNo prior history.\n\n---\n\n**Turn Context (split turn):**\n\n## Goal\nFIRST SUMMARY\n</previous-summary>");
  expect(second.data.summary).toBe("## Goal\nSECOND SUMMARY\n\n---\n\n**Turn Context (split turn):**\n\nFourth.");

  // The compaction entries match pi's: same summaries, and each keeps from the same message.
  const piEntries: Message[] = readFileSync(join(FIXTURES, "session-compact.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const keptText = (file: Message[], c: Message) => file.find((e) => e.id === c.firstKeptEntryId)!.message.content[0].text;
  const ours = entries();
  const summarize = (file: Message[]) => file.filter((e) => e.type === "compaction").map((c) => ({ summary: c.summary, kept: keptText(file, c) }));
  expect(summarize(ours)).toEqual(summarize(piEntries));
  expect(summarize(ours).map((c) => c.kept)).toEqual(["First answer with some words.", "Second answer with some words."]);

  // The q4 request is pi's, without pi's system prompt (edupi has none yet).
  const q4 = JSON.parse(readFileSync(join(FIXTURES, "session-compact.q4-request.json"), "utf8")).messages;
  expect(requests[6]).toEqual(q4.slice(1));
});

test("compact on a session with nothing to summarise ends with pi's error", async () => {
  edupi = startEdupi({ responses: [] });
  const response = await edupi.command("compact");
  expect(edupi.seen.filter((m) => m.type !== "trace")).toEqual([
    { type: "compaction_start", reason: "manual" },
    { type: "compaction_end", reason: "manual", aborted: false, willRetry: false, errorMessage: "Compaction failed: Nothing to compact (session too small)" },
    response,
  ]);
  expect(response).toEqual({ id: "1", type: "response", command: "compact", success: false, error: "Nothing to compact (session too small)" });
});
