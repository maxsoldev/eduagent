// Mirrors pi packages/agent/src/agent-loop.ts (pinned 16f5f0af4): the agent loop.
// It works with AgentMessages throughout and turns them into provider Messages only at the
// model call. One run: agent_start, then turns (turn_start, messages, turn_end), then agent_end.
// A turn is one model reply plus the tools it called; the loop goes on while the model calls tools.
import type { AssistantMessage, SystemMessage, ToolResultMessage } from "../ai/types.ts";
import { getCurrentTools, getToolStateChanges, type ToolStateChanges } from "../ai/utils/transcript.ts";
import { validateToolArguments } from "../ai/utils/validation.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolCallOutcome,
	AgentToolResult,
	StreamFn,
} from "./types.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/** Starts a run with new prompt messages. They go into the context, each with message events. */
export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	// If the transcript does not yet declare the agent's tools, a system message with toolsAdded goes first.
	const declared = declareToolChanges(context, prompts);
	const newMessages: AgentMessage[] = [...declared];
	const currentContext: AgentContext = { ...context, messages: [...context.messages, ...declared] };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const message of declared) {
		await emit({ type: "message_start", message });
		await emit({ type: "message_end", message });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

/**
 * Continues from the current context without a new message, e.g. to retry after the context was
 * compacted. The model answers the messages that are there (Agent.continue checks them).
 */
export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

/**
 * The loop shared by every run. Inner loop: call the model; if it called tools, run them and call
 * the model again. Steering messages go in before the next model call (drain points A, B, C).
 * Outer loop: when the agent would stop, queued follow-up messages start another inner loop.
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let firstTurn = true;
	let iteration = 0; // edupi: model calls in this run, for the loopIteration trace
	// Drain point A: the user may have steered while the run was starting.
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Outer loop: goes on when follow-up messages are queued after the agent would stop.
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: tool calls and steering messages.
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				// The session may compact here, and picks up a model or thinking level set during the run.
				const nextTurn = await config.prepareNextTurn?.({ context: currentContext });
				if (nextTurn) {
					currentContext = nextTurn.context ?? currentContext;
					config = {
						...config,
						model: nextTurn.model ?? config.model,
						reasoning:
							nextTurn.thinkingLevel === undefined
								? config.reasoning
								: nextTurn.thinkingLevel === "off"
									? undefined
									: nextTurn.thinkingLevel,
					};
				}
				// Drain point B: preparation can take long (compaction), so pick up steering sent meanwhile.
				// Poll only if the last poll gave nothing, else one-at-a-time mode would put two messages in this turn.
				if (pendingMessages.length === 0) pendingMessages = (await config.getSteeringMessages?.()) || [];
				await emit({ type: "turn_start" });
			}
			firstTurn = false;

			// Queued messages go in before the next assistant response.
			for (const message of declareToolChanges(currentContext, pendingMessages)) {
				await emit({ type: "message_start", message });
				await emit({ type: "message_end", message });
				currentContext.messages.push(message);
				newMessages.push(message);
			}
			pendingMessages = [];

			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
			newMessages.push(message);
			iteration++;

			// An error or an abort ends the run at once. Queued messages stay queued.
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await config.probe?.loopIteration?.({ iteration, needsFollowUp: false, message, decision: "stop" });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			const toolCalls = message.content.filter((c) => c.type === "toolCall");
			hasMoreToolCalls = toolCalls.length > 0;
			const toolResults = hasMoreToolCalls
				? await executeToolCallsParallel(currentContext, toolCalls, config, signal, emit)
				: [];
			for (const result of toolResults) {
				currentContext.messages.push(result);
				newMessages.push(result);
			}

			await emit({ type: "turn_end", message, toolResults });

			// Drain point C: steering sent while the model streamed or the tools ran.
			pendingMessages = (await config.getSteeringMessages?.()) || [];
			const decision = hasMoreToolCalls || pendingMessages.length > 0 ? "continue" : "stop";
			await config.probe?.loopIteration?.({ iteration, needsFollowUp: hasMoreToolCalls, message, decision });
		}

		// The agent would stop here. Follow-up messages become pending and start another inner loop.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			pendingMessages = followUpMessages;
			continue;
		}
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

// Declares tool changes to the model. context.tools is what the agent can run; the transcript's
// system messages declare what the model may call. The difference becomes toolsAdded and
// toolsRemoved, on a pending system message if there is one (the session's prompt sections),
// else on a new system message before the pending messages.
function declareToolChanges(context: AgentContext, pendingMessages: AgentMessage[]): AgentMessage[] {
	const changes = getToolStateChanges(getCurrentTools([...context.messages, ...pendingMessages]), context.tools ?? []);
	if (changes.toolsAdded.length === 0 && changes.toolsRemoved.length === 0) return pendingMessages;
	const systemIndex = pendingMessages.findLastIndex((m) => m.role === "system");
	if (systemIndex === -1) {
		return [withToolChanges({ role: "system", content: "", timestamp: Date.now() }, changes), ...pendingMessages];
	}
	return pendingMessages.map((m, i) => (i === systemIndex ? withToolChanges(m as SystemMessage, changes) : m));
}

/** A copy of a system message with the tool changes on it; empty lists leave the field out. */
function withToolChanges(message: SystemMessage, { toolsAdded, toolsRemoved }: ToolStateChanges): SystemMessage {
	return {
		...message,
		...(toolsAdded.length > 0 ? { toolsAdded } : {}),
		...(toolsRemoved.length > 0 ? { toolsRemoved } : {}),
	};
}

/**
 * Streams one assistant response. This is where AgentMessage[] becomes Message[]. The partial
 * message goes into the context at `start` and is replaced by each update and by the final message.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<AssistantMessage> {
	const llmMessages = await config.convertToLlm(context.messages);
	const llmContext = { messages: llmMessages };

	// Resolved per request, so an expiring key can be refreshed.
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;
	// edupi: step mode may pause here, before the request is built and sent.
	await config.probe?.checkpoint?.(
		"beforeModelRequest",
		{ messages: llmMessages.length, tools: getCurrentTools(llmMessages).length },
		signal,
	);

	const response = await streamFunction(config.model, llmContext, { ...config, apiKey: resolvedApiKey, signal });

	let addedPartial = false;
	for await (const event of response) {
		switch (event.type) {
			case "start":
				context.messages.push(event.partial);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...event.partial } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				context.messages[context.messages.length - 1] = event.partial;
				await emit({ type: "message_update", assistantMessageEvent: event, message: { ...event.partial } });
				break;
		}
	}

	// The stream ended with done or error (a request that failed at once has no start event).
	// Record the requested level, whichever stream function answered.
	const finalMessage = Object.assign(await response.result(), { thinkingLevel: config.reasoning ?? "off" });
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

/**
 * All calls start first, in call order (failures found while preparing end at once). Then they
 * run at the same time; each ends when it finishes. The result messages follow in call order.
 */
async function executeToolCallsParallel(
	currentContext: AgentContext,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
	// A call that failed in preparation is already finalized; the others run when Promise.all starts them.
	const finalizedCalls: (AgentToolCallOutcome | (() => Promise<AgentToolCallOutcome>))[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		// edupi: the teaching extras see the call, and step mode may pause before it runs.
		await config.probe?.toolDispatch?.({ toolCall, parallel: true });
		await config.probe?.checkpoint?.("beforeToolCall", { tool: toolCall.name, callId: toolCall.id }, signal);
		const preparation = prepareToolCall(currentContext, toolCall);
		if (preparation.kind === "immediate") {
			const finalized = { toolCall, result: preparation.result, isError: preparation.isError };
			await emitToolExecutionEnd(finalized, emit, config, signal);
			finalizedCalls.push(finalized);
			if (signal?.aborted) break;
			continue;
		}
		finalizedCalls.push(async () => {
			if (signal?.aborted) {
				const finalized = { toolCall, result: createErrorToolResult("Operation aborted"), isError: true };
				await emitToolExecutionEnd(finalized, emit, config, signal);
				return finalized;
			}
			const finalized = { toolCall, ...(await executePreparedToolCall(preparation, signal, emit)) };
			await emitToolExecutionEnd(finalized, emit, config, signal);
			return finalized;
		});
		if (signal?.aborted) break;
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : entry)),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}
	return messages;
}

type PreparedToolCall = { kind: "prepared"; toolCall: AgentToolCall; tool: AgentTool<any>; args: unknown };
type ImmediateToolCallOutcome = { kind: "immediate"; result: AgentToolResult<any>; isError: boolean };
type ExecutedToolCallOutcome = { result: AgentToolResult<any>; isError: boolean; durationMs: number };

/**
 * Finds the tool, lets it repair its arguments (prepareArguments), and checks them against its
 * schema. A failure is an error result, not an exception.
 */
function prepareToolCall(
	currentContext: AgentContext,
	toolCall: AgentToolCall,
): PreparedToolCall | ImmediateToolCallOutcome {
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool)
		return { kind: "immediate", result: createErrorToolResult(`Tool ${toolCall.name} not found`), isError: true };
	try {
		const prepared = tool.prepareArguments
			? { ...toolCall, arguments: tool.prepareArguments(toolCall.arguments) as AgentToolCall["arguments"] }
			: toolCall;
		return { kind: "prepared", toolCall, tool, args: validateToolArguments(tool, prepared) };
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

/**
 * Runs the tool; a thrown error becomes an error result. Each partial result becomes a
 * tool_execution_update. Updates sent after execute() settles are dropped, and the result
 * waits until the updates already sent are delivered.
 */
async function executePreparedToolCall(
	{ toolCall, tool, args }: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;
	const startedAt = performance.now();
	let result: AgentToolResult<any>;
	let isError: boolean;
	try {
		result = await tool.execute(toolCall.id, args, signal, (partialResult) => {
			if (!acceptingUpdates) return;
			const update = { toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments, partialResult };
			updateEvents.push(Promise.resolve(emit({ type: "tool_execution_update", ...update })));
		});
		isError = result.isError === true;
	} catch (error) {
		result = createErrorToolResult(error instanceof Error ? error.message : String(error));
		isError = true;
	}
	const durationMs = Math.round(performance.now() - startedAt);
	acceptingUpdates = false;
	await Promise.all(updateEvents);
	return { result, isError, durationMs };
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return { content: [{ type: "text", text: message }], details: {} };
}

/** edupi: config and signal are for the probe hooks. */
async function emitToolExecutionEnd(
	finalized: AgentToolCallOutcome,
	emit: AgentEventSink,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
		...(finalized.durationMs === undefined ? {} : { durationMs: finalized.durationMs }),
	});
	await config.probe?.toolOutput?.(finalized);
	await config.probe?.checkpoint?.(
		"afterToolCall",
		{ tool: finalized.toolCall.name, callId: finalized.toolCall.id },
		signal,
	);
}

/** The message the model reads: content and isError. details stay for the user interface. */
function createToolResultMessage(finalized: AgentToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		content: finalized.result.content,
		details: finalized.result.details,
		isError: finalized.isError,
		...(finalized.durationMs === undefined ? {} : { durationMs: finalized.durationMs }),
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
