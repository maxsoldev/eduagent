// Seam A: starts edupi in RPC mode as a child process, as the launcher does, and talks pi's RPC
// protocol to it over stdin/stdout: one JSON object per line. The model is the faux provider,
// scripted by a JSON file; it records every request body it receives.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = new URL("../bin/edupi.mjs", import.meta.url).pathname;

export type Message = Record<string, any>;

export class RpcClient {
	readonly seen: Message[] = [];
	private waiters: { match: (m: Message) => boolean; resolve: (m: Message) => void }[] = [];
	private stderr = "";
	private nextId = 1;

	constructor(
		private proc: ChildProcessWithoutNullStreams,
		readonly dir: string,
	) {
		let buffer = "";
		proc.stdout.setEncoding("utf8");
		proc.stdout.on("data", (chunk: string) => {
			buffer += chunk;
			while (true) {
				const i = buffer.indexOf("\n");
				if (i < 0) break;
				this.receive(JSON.parse(buffer.slice(0, i)));
				buffer = buffer.slice(i + 1);
			}
		});
		proc.stderr.on("data", (chunk) => (this.stderr += chunk));
	}

	private receive(message: Message) {
		this.seen.push(message);
		for (const w of [...this.waiters]) {
			if (w.match(message)) {
				this.waiters.splice(this.waiters.indexOf(w), 1);
				w.resolve(message);
			}
		}
	}

	/** What edupi wrote to stderr so far. */
	get stderrText(): string {
		return this.stderr;
	}

	/** Writes one raw line to edupi's stdin. */
	sendLine(line: string) {
		this.proc.stdin.write(`${line}\n`);
	}

	/** Sends a command with a fresh id and resolves with its response. */
	command(type: string, fields: Message = {}): Promise<Message> {
		const id = String(this.nextId++);
		const reply = this.until((m) => m.type === "response" && m.id === id);
		this.sendLine(JSON.stringify({ id, type, ...fields }));
		return reply;
	}

	/** Resolves with the first message (already seen or later) that matches. */
	until(match: string | ((m: Message) => boolean), timeoutMs = 10_000): Promise<Message> {
		const test = typeof match === "string" ? (m: Message) => m.type === match : match;
		const found = this.seen.find(test);
		if (found) return Promise.resolve(found);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`timed out waiting; stderr:\n${this.stderr}`)), timeoutMs);
			this.waiters.push({
				match: test,
				resolve: (m) => {
					clearTimeout(timer);
					resolve(m);
				},
			});
		});
	}

	/** The request bodies the faux provider received, in order (headers: only x-session-id). */
	requests(): { url: string; body: Message; headers?: Record<string, string> }[] {
		const log = join(this.dir, "faux-requests.jsonl");
		if (!existsSync(log)) return [];
		return readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
	}

	close(): Promise<number | null> {
		if (this.proc.exitCode !== null) return Promise.resolve(this.proc.exitCode);
		this.proc.stdin.end();
		return new Promise((resolve) => this.proc.once("close", resolve));
	}
}

export interface StartOptions {
	/** Directory to run in and to keep faux.json, the request log and the home. Default: a fresh one. */
	dir?: string;
	/** Run in this folder instead of dir (made if missing). */
	cwd?: string;
}

/**
 * Starts edupi with a faux script, in a temporary directory (also its cwd). Its home is
 * <dir>/home/agent, set with EDUPI_CODING_AGENT_DIR, so tests never touch ~/.eduagent.
 */
export function startEdupi(script: unknown, args: string[] = [], options: StartOptions = {}): RpcClient {
	const dir = options.dir ?? realpathSync(mkdtempSync(join(tmpdir(), "edupi-test-")));
	writeFileSync(join(dir, "faux.json"), JSON.stringify(script));
	const env = { ...process.env, OPENROUTER_API_KEY: "", EDUPI_CODING_AGENT_DIR: join(dir, "home", "agent") };
	const cwd = options.cwd ?? dir;
	mkdirSync(cwd, { recursive: true });
	const proc = spawn(
		process.execPath,
		[BIN, "--mode", "rpc", "--faux", join(dir, "faux.json"), "--faux-log", join(dir, "faux-requests.jsonl"), ...args],
		{ cwd, env },
	);
	return new RpcClient(proc, dir);
}

/**
 * A model with a tiny context window, as OpenRouter's GET /models would list it: `contextLength`
 * tokens after pi's system prompt, which starts every request. The prompt is measured in a fresh
 * test dir (all test dirs have the same path length, so the same prompt size).
 */
export async function tinyModel(contextLength: number): Promise<Message[]> {
	const edupi = startEdupi({ responses: ["ok"] });
	edupi.sendLine(JSON.stringify({ type: "prompt", message: "ok" }));
	await edupi.until("agent_settled");
	await edupi.close();
	const window = contextLength + Math.ceil(JSON.stringify([edupi.requests()[0].body.messages[0]]).length / 4);
	return [
		{
			id: "openai/gpt-6-luna",
			name: "Tiny Luna",
			context_length: window,
			top_provider: { context_length: window, max_completion_tokens: 50 },
			supported_parameters: ["tools"],
		},
	];
}
