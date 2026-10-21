// Mirrors pi packages/coding-agent/src/core/tools/bash.ts (pinned 16f5f0af4): the bash tool. It
// runs one command in the working directory with stdout and stderr merged, streams the output so
// far as partial results, and returns the tail of the output (2000 lines or 50KB). Longer output
// is saved to a temp file, and the model gets its path. A non-zero exit code is an error result.
// edupi leaves out pi's PI_* session variables, spawn hooks, command prefix and Windows shells.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import type { AgentTool, AgentToolUpdateCallback } from "../../../agent/types.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateTail } from "./truncate.ts";

/** pi's throttle for partial output (renderers/bash.ts). */
const BASH_UPDATE_THROTTLE_MS = 100;

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
 * Runs the command; onData gets stdout and stderr chunks. Resolves with the exit code. Throws
 * "aborted" or "timeout:<secs>", which execute() turns into pi's messages.
 */
async function exec(
	command: string,
	cwd: string,
	onData: (data: Buffer) => void,
	signal?: AbortSignal,
	timeout?: number,
) {
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
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
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
		// "close" waits for the output pipes. A background process can keep them open, so after
		// "exit" wait at most 100 ms more (pi waits until the pipes are idle).
		const exitCode = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code) => resolve(code));
			child.once("exit", (code) => setTimeout(() => resolve(code), 100));
		});
		if (signal?.aborted) throw new Error("aborted");
		if (timedOut) throw new Error(`timeout:${timeout}`);
		// A shell killed by a signal has no exit code: report 128 + signal number, as shells do.
		return exitCode ?? (child.signalCode ? 128 + (osConstants.signals[child.signalCode] ?? 0) : 1);
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

export function createBashTool(cwd: string): AgentTool<BashToolInput, BashToolDetails | undefined> {
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		parameters: bashSchema,
		async execute(
			_toolCallId,
			{ command, timeout },
			signal,
			onUpdate?: AgentToolUpdateCallback<BashToolDetails | undefined>,
		) {
			if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
				throw new Error("Invalid timeout: must be a finite number of seconds");
			}
			const decoder = new TextDecoder();
			let output = "";
			let fullOutputPath: string | undefined;

			// The tail of the output so far, and a temp file with all of it once it is too long.
			const snapshot = async () => {
				const truncation = truncateTail(output);
				if (truncation.truncated && !fullOutputPath) {
					fullOutputPath = join(tmpdir(), `pi-bash-${randomBytes(8).toString("hex")}.log`);
				}
				if (fullOutputPath) await writeFile(fullOutputPath, output, { mode: 0o600 });
				return { content: truncation.content, truncation, fullOutputPath };
			};

			// Partial results: one at the start, then at most one every 100 ms.
			let lastUpdateAt = 0;
			let updateTimer: NodeJS.Timeout | undefined;
			let dirty = false; // output came since the last update
			const emitUpdate = async () => {
				updateTimer = undefined;
				dirty = false;
				lastUpdateAt = Date.now();
				const s = await snapshot();
				onUpdate?.({
					content: [{ type: "text", text: s.content }],
					details: {
						truncation: s.truncation.truncated ? s.truncation : undefined,
						fullOutputPath: s.fullOutputPath,
					},
				});
			};
			const scheduleUpdate = () => {
				dirty = true;
				if (!onUpdate || updateTimer) return;
				updateTimer = setTimeout(emitUpdate, Math.max(0, BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt)));
			};
			onUpdate?.({ content: [], details: undefined });

			const formatOutput = (s: Awaited<ReturnType<typeof snapshot>>, emptyText = "(no output)") => {
				const { truncation } = s;
				let text = s.content || emptyText;
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: s.fullOutputPath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(
							Buffer.byteLength(output.split("\n").filter(Boolean).at(-1) ?? "", "utf-8"),
						);
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${s.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${s.fullOutputPath}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${s.fullOutputPath}]`;
					}
				}
				return { text, details };
			};
			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;
			const finish = async () => {
				if (updateTimer) clearTimeout(updateTimer);
				output += decoder.decode();
				if (onUpdate && dirty) await emitUpdate();
				return snapshot();
			};

			const startedAt = performance.now();
			let exitCode: number;
			try {
				exitCode = await exec(
					command,
					cwd,
					(data) => {
						output += decoder.decode(data, { stream: true });
						scheduleUpdate();
					},
					signal,
					timeout,
				);
			} catch (err) {
				const { text } = formatOutput(await finish(), "");
				if (err instanceof Error && err.message === "aborted")
					throw new Error(appendStatus(text, "Command aborted"));
				if (err instanceof Error && err.message.startsWith("timeout:")) {
					throw new Error(appendStatus(text, `Command timed out after ${err.message.split(":")[1]} seconds`));
				}
				throw err;
			}

			const { text, details } = formatOutput(await finish());
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
