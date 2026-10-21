// Mirrors pi packages/coding-agent/src/modes/rpc/rpc-mode.ts (pinned 16f5f0af4): RPC mode, pi's
// headless protocol over stdin/stdout. Commands come in as JSON lines with a `type` and an
// optional `id`. Each command gets one {type: "response", command, id, success} line. Every
// session event goes out as its own line. Lines are handled concurrently, so a slow command does
// not block a later one, and clients match responses by id.
import type { AgentSession } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { toJsonEvent } from "../json-event.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type { RpcCommand, RpcDebugContext, RpcResponse, RpcSessionState, RpcSlashCommand } from "./rpc-types.ts";

/**
 * Keeps stdout for protocol lines only: anything else that writes to stdout (console.log) goes
 * to stderr. Mirrors pi's takeOverStdout (core/output-guard.ts). Returns the real stdout writer.
 */
function takeOverStdout(): (line: string, done?: () => void) => void {
	const write = process.stdout.write.bind(process.stdout);
	process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
	return (line, done) => write(line, done);
}

/** edupi only: the teaching extras' debug_ commands (step mode, get context). pi has none. */
export interface DebugCommands {
	setStepMode(enabled: boolean, breakpoints?: string[]): { enabled: boolean; breakpoints: string[] };
	continue(): void;
	getContext(session: AgentSession): Promise<RpcDebugContext>;
}

/** edupi only: the teaching extras' hooks into RPC mode. */
export interface RpcModeOptions {
	/** Gets the protocol line writer, so the tracer can send trace messages on stdout. */
	connect: (output: (message: object) => void) => void;
	/** Answers the debug_ commands. */
	debug: DebugCommands;
}

/** The text of a thrown value. */
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runRpcMode(runtimeHost: AgentSessionRuntime, options: RpcModeOptions): Promise<never> {
	const writeRawStdout = takeOverStdout();
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;

	const output = (obj: RpcResponse | object) => writeRawStdout(serializeJsonLine(obj));
	options.connect(output);

	const success = (id: string | undefined, command: string, data?: object | null): RpcResponse => {
		if (data === undefined) return { id, type: "response", command, success: true } as RpcResponse;
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};

	/** Points the mode at the runtime's current session (it changes on new_session). */
	const rebindSession = () => {
		session = runtimeHost.session;
		unsubscribe?.();
		unsubscribe = session.subscribe((event) => output(toJsonEvent(event)));
	};
	rebindSession();

	const handleCommand = async (command: RpcCommand): Promise<RpcResponse | undefined> => {
		const id = command.id;

		switch (command.type) {
			case "prompt": {
				// The response is written once the prompt is accepted, before the run's events.
				// Failures after that are events (an assistant message with stopReason "error").
				let preflightSucceeded = false;
				void session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						preflightResult: (disposition) => {
							preflightSucceeded = true;
							output(success(id, "prompt", { disposition }));
						},
					})
					.catch((e) => {
						if (!preflightSucceeded) output(error(id, "prompt", e.message));
					});
				return undefined;
			}

			// Both queue the message, also when idle (then the next run picks it up). queue_update comes first.
			case "steer": {
				const disposition = await session.steer(command.message, command.images);
				return success(id, "steer", { disposition });
			}

			case "follow_up": {
				const disposition = await session.followUp(command.message, command.images);
				return success(id, "follow_up", { disposition });
			}

			// The response comes after the run has settled (after agent_settled).
			case "abort": {
				await session.abort();
				return success(id, "abort");
			}

			// thinking_level_changed (if the clamped level changed) comes before the response.
			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "get_state": {
				const state: RpcSessionState = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					pendingMessageCount: session.pendingMessageCount,
				};
				return success(id, "get_state", state);
			}

			case "new_session": {
				const result = await runtimeHost.newSession();
				if (!result.cancelled) rebindSession();
				return success(id, "new_session", result);
			}

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			case "get_commands": {
				const commands: RpcSlashCommand[] = session.resourceLoader.getSkills().skills.map((skill) => ({
					name: `skill:${skill.name}`,
					description: skill.description,
					source: "skill",
					sourceInfo: skill.sourceInfo,
				}));
				return success(id, "get_commands", { commands });
			}

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			// edupi's teaching extras (not in pi): step mode and the context inspector.
			case "debug_set_step_mode": {
				return success(id, "debug_set_step_mode", options.debug.setStepMode(command.enabled, command.breakpoints));
			}

			case "debug_continue": {
				options.debug.continue();
				return success(id, "debug_continue");
			}

			case "debug_get_context": {
				return success(id, "debug_get_context", await options.debug.getContext(session));
			}

			default: {
				const type = (command as { type: string }).type;
				return error(id, type, `Unknown command: ${type}`);
			}
		}
	};

	const handleInputLine = async (line: string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			output(error(undefined, "parse", `Failed to parse command: ${errorMessage(parseError)}`));
			return;
		}
		const command = parsed as RpcCommand;
		try {
			const response = await handleCommand(command);
			if (response) output(response);
		} catch (commandError: unknown) {
			output(error(command.id, command.type, errorMessage(commandError)));
		}
	};

	// The client closes stdin to end the session. SIGTERM (the launcher) exits with 143, as in pi.
	process.stdin.on("end", () => writeRawStdout("", () => process.exit(0))); // flush stdout first
	process.on("SIGTERM", () => process.exit(143));
	attachJsonlLineReader(process.stdin, (line) => {
		void handleInputLine(line);
	});

	return new Promise(() => {}); // keep the process alive
}
