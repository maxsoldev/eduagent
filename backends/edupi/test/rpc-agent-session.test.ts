// Seam A: AgentSession paths checked against pi's agent-session.ts (pinned 16f5f0af4): abort
// also cancels a compaction and waits for it; a prompt is refused only during a manual
// compaction; steer and follow_up expand /skill: commands. Also main.ts and rpc-mode.ts: a bad
// --session file and SIGTERM exit as pi does.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { type Message, type RpcClient, startEdupi } from "./rpc-client.ts";

let edupi: RpcClient;
afterEach(async () => {
	await edupi?.close();
});

function put(path: string, text: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

/** A test dir whose edupi home has this settings.json and a one-line SYSTEM.md (a small prompt). */
function dirWithSettings(settings: object): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "edupi-test-")));
	put(join(dir, "home", "agent", "settings.json"), JSON.stringify(settings));
	put(join(dir, "home", "agent", "SYSTEM.md"), "Be brief.");
	return dir;
}

const tinyModel = (contextLength: number) => [
	{
		id: "openai/gpt-6-luna",
		name: "Tiny Luna",
		context_length: contextLength,
		top_provider: { context_length: contextLength, max_completion_tokens: 50 },
		supported_parameters: ["tools"],
	},
];

const settledCount = () => edupi.seen.filter((m) => m.type === "agent_settled").length;
const untilSettled = (count = settledCount() + 1) => edupi.until(() => settledCount() >= count, 15_000);
const indexOf = (match: (m: Message) => boolean) => edupi.seen.findIndex(match);

async function prompt(message: string) {
	const count = settledCount() + 1;
	edupi.sendLine(JSON.stringify({ type: "prompt", message }));
	await untilSettled(count);
}

// 100 estimated tokens each; at 100 tokens per second a reply streams for about one second.
const LONG = "x".repeat(400);
const SLOW_SUMMARY = `## Goal\n${"y".repeat(400)}`;

test("abort during a manual compact cancels the summary; the abort response comes after compaction_end", async () => {
	edupi = startEdupi({ tokensPerSecond: 100, responses: ["First answer.", "Second answer.", SLOW_SUMMARY] }, [], {
		dir: dirWithSettings({ compaction: { keepRecentTokens: 5 } }),
	});
	await prompt("q1");
	await prompt("q2");

	const compactReply = edupi.command("compact");
	await edupi.until("compaction_start");
	const abortReply = await edupi.command("abort");
	expect((await compactReply).success).toBe(false);

	const end = edupi.seen.find((m) => m.type === "compaction_end");
	expect(end).toEqual({ type: "compaction_end", reason: "manual", aborted: true, willRetry: false });
	expect(indexOf((m) => m.type === "compaction_end")).toBeLessThan(indexOf((m) => m === abortReply));
});

test("during an automatic compaction a prompt gets pi's busy error, and abort cancels the compaction and the run", async () => {
	// Window 200, reserve 100: the 100-token reply puts the context above the threshold.
	edupi = startEdupi(
		{
			models: tinyModel(200),
			tokensPerSecond: 100,
			responses: ["First answer.", LONG, SLOW_SUMMARY, SLOW_SUMMARY, "Never sent."],
		},
		[],
		{ dir: dirWithSettings({ compaction: { reserveTokens: 100, keepRecentTokens: 101 } }) },
	);
	await prompt("q1");

	// After the run: threshold compaction before agent_settled.
	edupi.sendLine(JSON.stringify({ type: "prompt", message: "q2" }));
	await edupi.until("compaction_start");
	const busy = await edupi.command("prompt", { message: "too early" });
	expect(busy).toMatchObject({
		success: false,
		error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
	});
	const abortReply = await edupi.command("abort");
	const end = edupi.seen.find((m) => m.type === "compaction_end");
	expect(end).toEqual({ type: "compaction_end", reason: "threshold", aborted: true, willRetry: false });
	expect(edupi.seen.find((m) => m.type === "agent_settled" && m.aborted)).toBeDefined();
	expect(indexOf((m) => m.type === "agent_settled" && m.aborted)).toBeLessThan(indexOf((m) => m === abortReply));
});

test("steer and follow_up expand a /skill: command, as prompt does", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "edupi-test-")));
	const skillPath = join(dir, "home", "agent", "skills", "greet", "SKILL.md");
	put(skillPath, "---\nname: greet\ndescription: Greets the user.\n---\n\nSay hi.\n");
	const slowBash = {
		content: [{ type: "toolCall", id: "call_s", name: "bash", arguments: { command: "sleep 0.8; echo done" } }],
		stopReason: "toolUse",
	};
	edupi = startEdupi({ responses: [slowBash, "One.", "Two."] }, [], { dir });
	edupi.sendLine(JSON.stringify({ type: "prompt", message: "run slow" }));
	await edupi.until("tool_execution_start");
	expect(await edupi.command("steer", { message: "/skill:greet now" })).toMatchObject({
		data: { disposition: "queued" },
	});
	await edupi.command("follow_up", { message: "/skill:greet later" });
	const block = `<skill name="greet" location="${skillPath}">\nReferences are relative to ${dirname(skillPath)}.\n\nSay hi.\n</skill>`;
	const queues = edupi.seen.filter((m) => m.type === "queue_update");
	expect(queues[1]).toEqual({ type: "queue_update", steering: [`${block}\n\nnow`], followUp: [`${block}\n\nlater`] });
	await untilSettled();
});

/** Starts edupi with these extra arguments and resolves with its exit code and stderr. */
function runEdupi(args: string[], onStart?: (proc: ReturnType<typeof spawn>) => void) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "edupi-test-")));
	const bin = new URL("../bin/edupi.mjs", import.meta.url).pathname;
	const env = { ...process.env, OPENROUTER_API_KEY: "", EDUPI_CODING_AGENT_DIR: join(dir, "home", "agent") };
	const proc = spawn(process.execPath, [bin, "--mode", "rpc", "--offline", ...args], { cwd: dir, env });
	let stderr = "";
	proc.stderr.on("data", (chunk) => (stderr += chunk));
	onStart?.(proc);
	return {
		dir,
		done: new Promise<{ code: number | null; stderr: string }>((resolve) =>
			proc.once("close", (code) => resolve({ code, stderr })),
		),
	};
}

test("--session with a file that is not a session prints pi's one-line error and exits with 1", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "edupi-test-")));
	const file = join(dir, "bad.jsonl");
	writeFileSync(file, `${JSON.stringify({ type: "message", id: "a" })}\n`);
	const { code, stderr } = await runEdupi(["--session", file]).done;
	expect(code).toBe(1);
	expect(stderr).toMatch(/^Error: .+\n$/);
});

test("SIGTERM exits with 143, as pi's RPC mode does", async () => {
	const run = runEdupi([], (proc) => {
		proc.stdout?.once("data", () => proc.kill("SIGTERM")); // after the get_state response: RPC mode is up
		proc.stdin?.write(`${JSON.stringify({ id: "1", type: "get_state" })}\n`);
	});
	expect((await run.done).code).toBe(143);
});

test("--session works in the cwd of the file's header: its AGENTS.md and cwd go into the prompt", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "edupi-test-")));
	const project = join(dir, "project");
	put(join(project, "AGENTS.md"), "Project rules from the header's cwd.");
	const file = join(dir, "sessions", "s.jsonl");
	const header = {
		type: "session",
		version: 3,
		id: "01a15f55-0000-7000-8000-000000000001",
		timestamp: new Date().toISOString(),
		cwd: project,
	};
	put(file, `${JSON.stringify(header)}\n`);
	edupi = startEdupi({ responses: ["Hi."] }, ["--session", file], { dir, cwd: join(dir, "elsewhere") });
	await prompt("hello");
	const system = edupi.requests()[0].body.messages[0].content as string;
	expect(system).toContain("Project rules from the header's cwd.");
	expect(system).toContain(`<cwd>\n${project}\n</cwd>`);
});

test("bash commands see the session as PI_* variables, read when the command runs", async () => {
	const command = 'echo "$PI_SESSION_ID|$PI_SESSION_FILE|$PI_PROVIDER|$PI_MODEL|$PI_REASONING_LEVEL"';
	const bash = {
		content: [{ type: "toolCall", id: "call_e", name: "bash", arguments: { command } }],
		stopReason: "toolUse",
	};
	edupi = startEdupi({ responses: [bash, "Done."] });
	await prompt("show the env");
	const state = (await edupi.command("get_state")).data;
	const end = edupi.seen.find((m) => m.type === "tool_execution_end")!;
	expect(end.result.content[0].text.trim()).toBe(
		`${state.sessionId}|${state.sessionFile}|openrouter|openai/gpt-6-luna|off`,
	);
});
