// Mirrors pi packages/coding-agent/src/core/tools/bash.ts (pinned 16f5f0af4): the bash tool. It
// runs one command in the working directory with stdout and stderr merged, streams the output so
// far as partial results, and returns the tail of the output (2000 lines or 50KB). A non-zero exit
// code is an error result.
// edupi leaves out pi's spawn hooks, command prefix, other shells and the temp file with the full output.

import { type ChildProcess, spawn } from "node:child_process";
import { type Static, Type } from "typebox";
import type { AgentTool } from "../../../agent/types.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateTail } from "./truncate.ts";

const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export const bashToolSystemPromptContribution = {
	snippet: "Execute bash commands (ls, grep, find, etc.)",
	guidelines: ["You can inspect PI_* environment variables for current model and session details."],
} as const;

type BashToolInput = Static<typeof bashSchema>;

interface BashToolDetails {
	truncation?: TruncationResult;
}

/** What pi exposes to commands as PI_* variables (pi reads them from the tool call's context). */
interface BashSessionEnvironment {
	sessionId: string;
	sessionFile?: string;
	provider: string;
	model: string;
	thinkingLevel: string;
}

export interface BashToolOptions {
	/** The current session, read at each call. */
	getSessionEnvironment?: () => BashSessionEnvironment;
}

/** pi's resolveSpawnContext env. spawn skips variables whose value is undefined. */
function getCommandEnv(session: BashSessionEnvironment | undefined): NodeJS.ProcessEnv {
	if (!session) return process.env;
	return {
		...process.env,
		PI_SESSION_ID: session.sessionId,
		PI_SESSION_FILE: session.sessionFile,
		PI_PROVIDER: session.provider,
		PI_MODEL: session.model,
		PI_REASONING_LEVEL: session.thinkingLevel,
	};
}

/** Kills the command and everything it started: the shell runs detached, as its own process group. */
function killProcessTree(pid: number) {
	try {
		process.kill(-pid, "SIGKILL");
	} catch {} // already gone
}

/**
 * Resolves with the exit code. "close" waits for the output pipes, but a background process can
 * keep them open, so after "exit" wait at most 100 ms more (pi waits until the pipes are idle).
 */
function waitForChildProcess(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code));
		child.once("exit", (code) => setTimeout(() => resolve(code), 100));
	});
}

/**
 * Runs the command; onData gets stdout and stderr chunks. Resolves with the exit code. Throws
 * "aborted" or "timeout:<secs>", which execute() turns into pi's messages.
 */
async function exec(
	command: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	onData: (data: Buffer) => void,
	signal?: AbortSignal,
	timeout?: number,
): Promise<number> {
	if (signal?.aborted) throw new Error("aborted");
	const child = spawn("/bin/bash", ["-c", command], { cwd, detached: true, env, stdio: ["ignore", "pipe", "pipe"] });
	let timedOut = false;
	const timer =
		timeout !== undefined
			? setTimeout(() => {
					timedOut = true;
					if (child.pid) killProcessTree(child.pid);
				}, timeout * 1000)
			: undefined;
	const onAbort = () => child.pid && killProcessTree(child.pid);
	signal?.addEventListener("abort", onAbort, { once: true });
	child.stdout.on("data", onData);
	child.stderr.on("data", onData);
	try {
		const exitCode = await waitForChildProcess(child);
		if (signal?.aborted) throw new Error("aborted");
		if (timedOut) throw new Error(`timeout:${timeout}`);
		return exitCode ?? 1;
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

/** The tail the model reads, with pi's note when lines were cut. */
function formatOutput(output: string, emptyText = "(no output)"): { text: string; details?: BashToolDetails } {
	const truncation = truncateTail(output);
	const text = truncation.content || emptyText;
	if (!truncation.truncated) return { text };
	const startLine = truncation.totalLines - truncation.outputLines + 1;
	const endLine = truncation.totalLines;
	const limit = truncation.truncatedBy === "lines" ? "" : ` (${formatSize(DEFAULT_MAX_BYTES)} limit)`;
	return {
		text: `${text}\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}${limit}.]`,
		details: { truncation },
	};
}

const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

export function createBashTool(
	cwd: string,
	options: BashToolOptions = {},
): AgentTool<BashToolInput, BashToolDetails | undefined> {
	return {
		name: "bash",
		label: "bash",
		// pi's text, so the tool spec equals pi's (edupi has no temp file).
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		parameters: bashSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(_toolCallId, { command, timeout }, signal, onUpdate) {
			// A chunk may end inside a UTF-8 character: the streaming decoder keeps those bytes for the next chunk.
			const decoder = new TextDecoder();
			let output = "";
			// Partial results: one at the start, then the tail so far after each chunk.
			onUpdate?.({ content: [], details: undefined });
			const handleData = (data: Buffer) => {
				output += decoder.decode(data, { stream: true });
				const truncation = truncateTail(output);
				onUpdate?.({
					content: [{ type: "text", text: truncation.content }],
					details: truncation.truncated ? { truncation } : undefined,
				});
			};

			const startedAt = performance.now();
			let exitCode: number;
			try {
				const env = getCommandEnv(options.getSessionEnvironment?.());
				exitCode = await exec(command, cwd, env, handleData, signal, timeout);
			} catch (err) {
				const { text } = formatOutput(output + decoder.decode(), "");
				if (err instanceof Error && err.message === "aborted") {
					throw new Error(appendStatus(text, "Command aborted"));
				}
				if (err instanceof Error && err.message.startsWith("timeout:")) {
					const timeoutSecs = err.message.split(":")[1];
					throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
				}
				throw err;
			}

			output += decoder.decode();
			const { text, details } = formatOutput(output);
			const structuredContent = {
				output,
				truncated: false,
				exit_code: exitCode,
				wall_time_seconds: Math.round((performance.now() - startedAt) / 100) / 10,
			};
			if (exitCode !== 0) {
				return {
					content: [{ type: "text", text: appendStatus(text, `Command exited with code ${exitCode}`) }],
					details,
					structuredContent,
					isError: true,
				};
			}
			return { content: [{ type: "text", text }], details, structuredContent };
		},
	};
}
