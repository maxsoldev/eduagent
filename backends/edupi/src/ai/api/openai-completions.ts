// Mirrors pi packages/ai/src/api/openai-completions.ts (pinned 16f5f0af4): the OpenAI Chat
// Completions API, called with the OpenAI SDK. edupi points the SDK at OpenRouter, which speaks
// the same wire format. Same steps as pi: convert the transcript to Chat Completions messages,
// build the request body, stream the chunks and turn them into AssistantMessageEvents.
import OpenAI from "openai";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionChunk,
	ChatCompletionContentPart,
	ChatCompletionCreateParamsStreaming,
	ChatCompletionMessageParam,
	ChatCompletionTool,
} from "openai/resources/chat/completions";
import { clampThinkingLevel } from "../models.ts";
import type {
	AssistantMessage,
	Model,
	SimpleStreamOptions,
	StopReason,
	TextContent,
	ThinkingContent,
	ThinkingLevel,
	Tool,
	ToolCall,
	ToolResultMessage,
	TranscriptContext,
	Usage,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { parseStreamingJson, parseToolCallArguments } from "../utils/json-parse.ts";
import { collapseSystemMessages, getCurrentTools, getSystemMessageText } from "../utils/transcript.ts";
import { transformMessages } from "./transform-messages.ts";

/**
 * pi's resolved OpenRouter compat (detectCompat): `store`, usage in the stream, and the developer
 * role, which OpenRouter passes only to OpenAI and Anthropic models. edupi has no other provider.
 */
function supportsDeveloperRole(model: Model): boolean {
	return model.id.startsWith("openai/") || model.id.startsWith("anthropic/");
}

/** stream()'s own options: streamSimple turns the thinking level into a reasoning effort. */
export interface OpenAICompletionsOptions extends SimpleStreamOptions {
	reasoningEffort?: Exclude<ThinkingLevel, "off">;
}

/** The Chat Completions delta fields that can carry reasoning text; the first non-empty one wins. */
const REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text"] as const;

/** A tool call block while it streams: the raw arguments text rides along until the end. */
type StreamingToolCall = ToolCall & { partialArgs?: string };

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Streams one Chat Completions response. Failures end the stream with an `error` event; it never throws. */
export function stream(
	model: Model,
	context: TranscriptContext,
	options?: OpenAICompletionsOptions,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "pending",
			timestamp: Date.now(),
		};

		let requested = false; // edupi: a model response is traced only after a traced request
		try {
			if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
			const cacheSessionId = options.cacheRetention === "none" ? undefined : options.sessionId;
			const client = createClient(model, options.apiKey, options.fetch, cacheSessionId);
			let params = buildParams(model, context, options);
			const nextParams = await options.onPayload?.(params, model);
			if (nextParams !== undefined) params = nextParams as ChatCompletionCreateParamsStreaming;
			requested = true;
			await options.probe?.modelRequest?.(
				{ api: model.api, url: `${model.baseUrl}/chat/completions`, body: params },
				options.sessionId,
			);
			const openaiStream = await client.chat.completions.create(params, { signal: options.signal, maxRetries: 0 });
			stream.push({ type: "start", partial: output });

			let textBlock: TextContent | null = null;
			let thinkingBlock: ThinkingContent | null = null;
			const blocks = output.content;
			const toolCallBlocksByIndex = new Map<number, StreamingToolCall>();
			const getContentIndex = (block: (typeof blocks)[number]) => blocks.indexOf(block);
			const ensureTextBlock = () => {
				if (!textBlock) {
					textBlock = { type: "text", text: "" };
					blocks.push(textBlock);
					stream.push({ type: "text_start", contentIndex: getContentIndex(textBlock), partial: output });
				}
				return textBlock;
			};
			// The field the reasoning came in is kept as the signature, so a replay can use the same field.
			const ensureThinkingBlock = (thinkingSignature: string) => {
				if (!thinkingBlock) {
					thinkingBlock = { type: "thinking", thinking: "", thinkingSignature };
					blocks.push(thinkingBlock);
					stream.push({ type: "thinking_start", contentIndex: getContentIndex(thinkingBlock), partial: output });
				}
				return thinkingBlock;
			};
			// Tool calls are keyed by the stream's index: the first delta has the id and the name, later ones only argument text.
			const ensureToolCallBlock = (delta: { index: number; id?: string; function?: { name?: string } }) => {
				let block = toolCallBlocksByIndex.get(delta.index);
				if (!block) {
					block = {
						type: "toolCall",
						id: delta.id ?? "",
						name: delta.function?.name ?? "",
						arguments: {},
						partialArgs: "",
					};
					toolCallBlocksByIndex.set(delta.index, block);
					blocks.push(block);
					stream.push({ type: "toolcall_start", contentIndex: getContentIndex(block), partial: output });
				}
				return block;
			};
			const finishBlock = (block: (typeof blocks)[number]) => {
				if (block.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex: getContentIndex(block),
						content: block.text,
						partial: output,
					});
				} else if (block.type === "thinking") {
					stream.push({
						type: "thinking_end",
						contentIndex: getContentIndex(block),
						content: block.thinking,
						partial: output,
					});
				} else if (block.type === "toolCall") {
					const toolCall = block as StreamingToolCall;
					Object.assign(toolCall, parseToolCallArguments(toolCall.partialArgs));
					delete toolCall.partialArgs; // only the parsed arguments are kept
					stream.push({ type: "toolcall_end", contentIndex: getContentIndex(block), toolCall, partial: output });
				}
			};

			for await (const chunk of openaiStream) {
				await options.probe?.streamEvent?.(chunk);
				// Every chunk of one completion carries the same id.
				output.responseId ||= chunk.id;
				if (chunk.usage) output.usage = parseChunkUsage(chunk.usage, model);

				const choice = chunk.choices[0];
				if (!choice) continue;

				if (choice.finish_reason) {
					const result = mapStopReason(choice.finish_reason);
					output.stopReason = result.stopReason;
					if (result.errorMessage) output.errorMessage = result.errorMessage;
				}

				// Reasoning before content: the thinking block must come before the text block.
				const deltaFields = (choice.delta ?? {}) as Record<string, unknown>;
				const reasoningField = REASONING_FIELDS.find(
					(field) => typeof deltaFields[field] === "string" && (deltaFields[field] as string).length > 0,
				);
				if (reasoningField) {
					const delta = deltaFields[reasoningField] as string;
					const block = ensureThinkingBlock(reasoningField);
					block.thinking += delta;
					stream.push({ type: "thinking_delta", contentIndex: getContentIndex(block), delta, partial: output });
				}

				if (choice.delta?.content) {
					const block = ensureTextBlock();
					block.text += choice.delta.content;
					stream.push({
						type: "text_delta",
						contentIndex: getContentIndex(block),
						delta: choice.delta.content,
						partial: output,
					});
				}

				for (const toolCall of choice.delta?.tool_calls ?? []) {
					const block = ensureToolCallBlock(toolCall);
					const delta = toolCall.function?.arguments ?? "";
					if (delta) {
						block.partialArgs = (block.partialArgs ?? "") + delta;
						block.arguments = parseStreamingJson(block.partialArgs, block.arguments);
					}
					stream.push({ type: "toolcall_delta", contentIndex: getContentIndex(block), delta, partial: output });
				}
			}

			for (const block of blocks) finishBlock(block);
			if (options.signal?.aborted) throw new Error("Request was aborted");
			if (output.stopReason === "error") throw new Error(output.errorMessage);
			if (output.stopReason === "pending") throw new Error("Stream ended without finish_reason");

			await options.probe?.modelResponse?.(output);
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			// A stream that broke mid-way has unfinished blocks: drop their scratch buffers, never persist them.
			for (const block of output.content) delete (block as StreamingToolCall).partialArgs;
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			// The OpenAI SDK's message: "<status> <error.message>" for an HTTP error.
			output.errorMessage = error instanceof Error ? error.message : String(error);
			// OpenRouter puts the upstream provider's error text here.
			const rawMetadata = (error as { error?: { metadata?: { raw?: unknown } } })?.error?.metadata?.raw;
			if (rawMetadata && !output.errorMessage.includes(String(rawMetadata)))
				output.errorMessage += `\n${rawMetadata}`;
			if (requested) await options?.probe?.modelResponse?.(output);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

/**
 * The agent's entry point: pi's streamSimple fills request options from the model, clamps the
 * thinking level to what the model supports and passes it on as the reasoning effort.
 */
export function streamSimple(
	model: Model,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	return stream(model, context, toCompletionsOptions(model, options));
}

/** streamSimple's option mapping. edupi exports it, so the context inspector builds the same body. */
export function toCompletionsOptions(model: Model, options?: SimpleStreamOptions): OpenAICompletionsOptions {
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
	return { ...options, maxTokens: options?.maxTokens ?? model.maxTokens, reasoningEffort };
}

function createClient(model: Model, apiKey: string, fetch?: typeof globalThis.fetch, sessionId?: string) {
	const headers: Record<string, string> = {};
	if (sessionId) headers["x-session-id"] = sessionId; // OpenRouter session affinity: same upstream, warm cache
	return new OpenAI({ apiKey, baseURL: model.baseUrl, dangerouslyAllowBrowser: true, fetch, defaultHeaders: headers });
}

/** The request body. Field order follows pi's, so a recorded body reads the same as pi's. */
export function buildParams(
	model: Model,
	context: TranscriptContext,
	options: OpenAICompletionsOptions | undefined,
): ChatCompletionCreateParamsStreaming {
	const params: ChatCompletionCreateParamsStreaming = {
		model: model.id,
		messages: convertMessages(model, context),
		stream: true,
		stream_options: { include_usage: true },
		store: false,
	};
	if (options?.maxTokens) params.max_completion_tokens = options.maxTokens;
	// The tools come from the transcript: the system messages declare them.
	const tools = getCurrentTools(context.messages);
	if (tools.length > 0) params.tools = convertTools(tools);
	// OpenRouter's reasoning object works for every provider behind it (pi's thinkingFormat
	// "openrouter"). No level means reasoning off: the map's "off" effort, else "none". A model
	// that cannot turn reasoning off (map.off null) and non-reasoning models get no field.
	if (model.reasoning) {
		const openRouterParams = params as typeof params & { reasoning?: { effort?: string } };
		if (options?.reasoningEffort) {
			openRouterParams.reasoning = {
				effort: model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort,
			};
		} else if (model.thinkingLevelMap?.off !== null) {
			openRouterParams.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
		}
	}
	return params;
}

/** Transcript messages to Chat Completions messages. */
function convertMessages(model: Model, transcript: TranscriptContext): ChatCompletionMessageParam[] {
	// pi's OpenRouter compat has no mid-conversation system messages: the prompt is replayed into one leading message.
	const context = collapseSystemMessages(transcript);
	const params: ChatCompletionMessageParam[] = [];
	// Reasoning models take the harness's instructions as "developer", as in the Responses API.
	const instructionRole = model.reasoning && supportsDeveloperRole(model) ? "developer" : "system";

	// pi's transformMessages: no errored or aborted replies, and every tool call gets a result.
	for (const msg of transformMessages(context.messages, model)) {
		if (msg.role === "system") {
			const text = getSystemMessageText(msg);
			if (text.length > 0) params.push({ role: instructionRole, content: text });
		} else if (msg.role === "user") {
			if (typeof msg.content === "string") {
				params.push({ role: "user", content: msg.content });
				continue;
			}
			const content = msg.content
				.filter((item) => item.type !== "text" || item.text.length > 0)
				.map(
					(item): ChatCompletionContentPart =>
						item.type === "text"
							? { type: "text", text: item.text }
							: { type: "image_url", image_url: { url: `data:${item.mimeType};base64,${item.data}` } },
				);
			if (content.length > 0) params.push({ role: "user", content });
		} else if (msg.role === "assistant") {
			const assistantMsg = convertAssistantMessage(msg);
			if (assistantMsg) params.push(assistantMsg);
		} else if (msg.role === "toolResult") {
			params.push(convertToolResult(msg));
		}
	}
	return params;
}

/** An assistant reply as one message: its text, its reasoning and its tool calls (inline in pi's convertMessages). */
function convertAssistantMessage(msg: AssistantMessage): ChatCompletionAssistantMessageParam | undefined {
	const assistantMsg: ChatCompletionAssistantMessageParam = { role: "assistant", content: null };
	// Assistant text goes back as one plain string, the Chat Completions standard.
	const text = msg.content
		.filter((b): b is TextContent => b.type === "text" && b.text.trim().length > 0)
		.map((b) => b.text)
		.join("");
	if (text.length > 0) assistantMsg.content = text;
	// Reasoning goes back in the field it came in (the block's signature), so the model sees its thinking.
	const thinkingBlocks = msg.content.filter(
		(b): b is ThinkingContent => b.type === "thinking" && b.thinking.trim().length > 0,
	);
	const signature = thinkingBlocks[0]?.thinkingSignature;
	if (signature && (REASONING_FIELDS as readonly string[]).includes(signature)) {
		(assistantMsg as unknown as Record<string, unknown>)[signature] = thinkingBlocks
			.map((b) => b.thinking)
			.join("\n");
	}
	const toolCalls = msg.content.filter((b): b is ToolCall => b.type === "toolCall");
	if (toolCalls.length > 0) {
		assistantMsg.tool_calls = toolCalls.map((tc) => ({
			id: tc.id,
			type: "function" as const,
			function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
		}));
	}
	// Providers refuse an assistant message with neither content nor tool calls (an aborted reply).
	if (assistantMsg.content === null && !assistantMsg.tool_calls) return undefined;
	return assistantMsg;
}

/** One "tool" message per result, answering the call with the same id. Its content is plain text. */
function convertToolResult(msg: ToolResultMessage): ChatCompletionMessageParam {
	const text = msg.content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	return { role: "tool", content: text.trim().length > 0 ? text : "(no tool output)", tool_call_id: msg.toolCallId };
}

/** Tools as Chat Completions function specs. OpenRouter gets no `strict` field (pi's compat: supportsStrictMode false). */
function convertTools(tools: Tool[]): ChatCompletionTool[] {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters as Record<string, unknown>,
		},
	}));
}

function parseChunkUsage(rawUsage: NonNullable<ChatCompletionChunk["usage"]>, model: Model): Usage {
	const promptTokens = rawUsage.prompt_tokens || 0;
	const cacheReadTokens = rawUsage.prompt_tokens_details?.cached_tokens ?? 0;
	const cacheWriteTokens =
		(rawUsage.prompt_tokens_details as { cache_write_tokens?: number } | undefined)?.cache_write_tokens || 0;
	const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
	const outputTokens = rawUsage.completion_tokens || 0; // already includes reasoning tokens
	const usage: Usage = {
		input,
		output: outputTokens,
		cacheRead: cacheReadTokens,
		cacheWrite: cacheWriteTokens,
		reasoning: rawUsage.completion_tokens_details?.reasoning_tokens || 0,
		totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}

/** Mirrors pi packages/ai/src/models.ts calculateCost: model prices are USD per million tokens. */
export function calculateCost(model: Model, usage: Usage): Usage["cost"] {
	usage.cost.input = (model.cost.input / 1_000_000) * usage.input;
	usage.cost.output = (model.cost.output / 1_000_000) * usage.output;
	usage.cost.cacheRead = (model.cost.cacheRead / 1_000_000) * usage.cacheRead;
	usage.cost.cacheWrite = (model.cost.cacheWrite / 1_000_000) * usage.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

function mapStopReason(reason: string): { stopReason: StopReason; errorMessage?: string } {
	switch (reason) {
		case "stop":
		case "end":
			return { stopReason: "stop" };
		case "length":
			return { stopReason: "length" };
		case "function_call":
		case "tool_calls":
			return { stopReason: "toolUse" };
		default:
			return { stopReason: "error", errorMessage: `Provider finish_reason: ${reason}` };
	}
}
