// Mirrors pi packages/coding-agent/src/core/tools/bash.ts (pinned 16f5f0af4): the bash tool. It
// runs one command in the working directory with stdout and stderr merged, streams the output so
// far as partial results, and returns the tail of the output (2000 lines or 50KB). Longer output
// is saved to a temp file, and the model gets its path. A non-zero exit code is an error result.
// edupi leaves out pi's spawn hooks, command prefix and Windows shells.

import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { type Static, Type } from "typebox";
import type { AgentTool, AgentToolUpdateCallback } from "../../../agent/types.ts";
import { OutputAccumulator, type OutputSnapshot } from "./output-accumulator.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.ts";

/** pi's throttle for partial output (renderers/bash.ts). */
const BASH_UPDATE_THROTTLE_MS = 100;
/** Node's timer limit: a longer setTimeout fires at once. */
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	return timeoutMs;
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export const bashToolSystemPromptContribution = {
	snippet: "Execute bash commands (ls, grep, find, etc.)",
	guidelines: ["You can inspect PI_* environment variables for current model and session details."],
} as const;

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/** What pi exposes to commands as PI_* variables (pi reads them from the tool call's context). */
export interface BashSessionEnvironment {
	sessionId: string;
	sessionFile?: string;
	provider?: string;
	model?: string;
	thinkingLevel?: string;
}

export interface BashToolOptions {
	/** The current session, read at each call. Without it, commands get no PI_* variables. */
	getSessionEnvironment?: () => BashSessionEnvironment;
}

/** pi's resolveSpawnContext env: PI_* variables from a parent pi are dropped, then the session's are set. */
function getCommandEnv(session: BashSessionEnvironment | undefined): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	delete env.PI_REASONING_LEVEL;
	if (session) {
		env.PI_SESSION_ID = session.sessionId;
		if (session.sessionFile) env.PI_SESSION_FILE = session.sessionFile;
		if (session.provider && session.model) {
			env.PI_PROVIDER = session.provider;
			env.PI_MODEL = session.model;
		}
		if (session.thinkingLevel) env.PI_REASONING_LEVEL = session.thinkingLevel;
	}
	return env;
}

/** /bin/bash, else sh (pi utils/shell.ts getShellConfig also searches PATH). */
async function getShell(): Promise<{ shell: string; args: string[] }> {
	try {
		await access("/bin/bash", constants.X_OK);
		return { shell: "/bin/bash", args: ["-c"] };
	} catch {
		return { shell: "sh", args: ["-c"] };
	}
}

/** Kills the command and everything it started: the shell runs detached, as its own process group. */
function killProcessTree(pid: number) {
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
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
	const timeoutMs = resolveTimeoutMs(timeout);
	if (signal?.aborted) throw new Error("aborted");
	try {
		await access(cwd, constants.F_OK);
	} catch {
		throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
	}
	const { shell, args } = await getShell();
	const child = spawn(shell, [...args, command], {
		cwd,
		detached: true,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let timedOut = false;
	const timer =
		timeoutMs !== undefined
			? setTimeout(() => {
					timedOut = true;
					if (child.pid) killProcessTree(child.pid);
				}, timeoutMs)
			: undefined;
	const onAbort = () => child.pid && killProcessTree(child.pid);
	signal?.addEventListener("abort", onAbort, { once: true });
	child.stdout.on("data", onData);
	child.stderr.on("data", onData);
	try {
		const exitCode = await waitForChildProcess(child);
		if (signal?.aborted) throw new Error("aborted");
		if (timedOut) throw new Error(`timeout:${timeout}`);
		// A shell killed by a signal has no exit code: report 128 + signal number, as shells do.
		return exitCode ?? (child.signalCode ? 128 + (osConstants.signals[child.signalCode] ?? 0) : 1);
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

export function createBashTool(
	cwd: string,
	options: BashToolOptions = {},
): AgentTool<BashToolInput, BashToolDetails | undefined> {
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		parameters: bashSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ command, timeout },
			signal,
			onUpdate?: AgentToolUpdateCallback<BashToolDetails | undefined>,
		) {
			const output = new OutputAccumulator();

			// Partial results: one at the start, then at most one every 100 ms.
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false; // output came since the last update
			let lastUpdateAt = 0;
			const emitOutputUpdate = async () => {
				updateTimer = undefined;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = await output.snapshot();
				onUpdate?.({
					content: [{ type: "text", text: snapshot.content }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};
			const scheduleOutputUpdate = () => {
				updateDirty = true;
				if (!onUpdate || updateTimer) return;
				const delay = Math.max(0, BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt));
				updateTimer = setTimeout(emitOutputUpdate, delay);
			};
			onUpdate?.({ content: [], details: undefined });

			const handleData = (data: Buffer) => {
				output.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				if (updateTimer) clearTimeout(updateTimer);
				output.finish();
				if (onUpdate && updateDirty) await emitOutputUpdate();
				return output.snapshot();
			};

			const formatOutput = (snapshot: OutputSnapshot, emptyText = "(no output)") => {
				const { truncation } = snapshot;
				let text = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;
			const startedAt = performance.now();

			let exitCode: number;
			try {
				const env = getCommandEnv(options.getSessionEnvironment?.());
				exitCode = await exec(command, cwd, env, handleData, signal, timeout);
			} catch (err) {
				const { text } = formatOutput(await finishOutput(), "");
				if (err instanceof Error && err.message === "aborted") {
					throw new Error(appendStatus(text, "Command aborted"));
				}
				if (err instanceof Error && err.message.startsWith("timeout:")) {
					const timeoutSecs = err.message.split(":")[1];
					throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
				}
				throw err;
			}

			const { text: outputText, details } = formatOutput(await finishOutput());
			const structuredContent = {
				output: output.readFullOutput(),
				truncated: false,
				exit_code: exitCode,
				wall_time_seconds: Math.round((performance.now() - startedAt) / 100) / 10,
			};
			if (exitCode !== 0) {
				return {
					content: [{ type: "text", text: appendStatus(outputText, `Command exited with code ${exitCode}`) }],
					details,
					structuredContent,
					isError: true,
				};
			}
			return { content: [{ type: "text", text: outputText }], details, structuredContent };
		},
	};
}
