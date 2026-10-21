// Mirrors pi packages/ai/src/providers/faux.ts (pinned 16f5f0af4): a scripted model for tests.
// Each model request takes the next queued assistant message and streams it in small random chunks.
// Unlike pi's (which replaces the whole API), edupi's faux is a `fetch` for the OpenAI SDK: it
// answers with Chat Completions SSE chunks, so the real openai-completions code runs and each body
// is recorded. GET /models answers with the script's models (context window, prices).
import { readFileSync } from "node:fs";
import type {
	AssistantMessage,
	JsonObject,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
	Usage,
} from "../types.ts";
import type { OpenRouterModel } from "./openrouter.ts";

const DEFAULT_MIN_TOKEN_SIZE = 3;
const DEFAULT_MAX_TOKEN_SIZE = 5;

const DEFAULT_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export type FauxContentBlock = TextContent | ThinkingContent | ToolCall;

export function fauxText(text: string): TextContent {
	return { type: "text", text };
}

export function fauxThinking(thinking: string): ThinkingContent {
	return { type: "thinking", thinking };
}

export function fauxToolCall(name: string, args: JsonObject, options: { id?: string } = {}): ToolCall {
	return {
		type: "toolCall",
		id: options.id ?? `tool:${Math.random().toString(36).slice(2, 10)}`,
		name,
		arguments: args,
	};
}

function normalizeFauxAssistantContent(content: string | FauxContentBlock | FauxContentBlock[]): FauxContentBlock[] {
	if (typeof content === "string") return [fauxText(content)];
	return Array.isArray(content) ? content : [content];
}

/** A scripted reply. Only content and stopReason matter; the provider fills in the rest. */
export function fauxAssistantMessage(
	content: string | FauxContentBlock | FauxContentBlock[],
	options: { stopReason?: StopReason } = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: normalizeFauxAssistantContent(content),
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: DEFAULT_USAGE,
		stopReason: options.stopReason ?? "stop",
		timestamp: Date.now(),
	};
}

/** A scripted HTTP error, e.g. a context overflow: `{error: {status: 400, message: "..."}}`. */
export interface FauxError {
	error: { status?: number; message: string };
}

/** edupi: a reply whose connection breaks after its content chunks, before the finish chunk. */
export type FauxBrokenStream = AssistantMessage & { streamError: string };

export type FauxResponse = AssistantMessage | FauxBrokenStream | FauxError;

export interface RegisterFauxProviderOptions {
	tokensPerSecond?: number; // delay between chunks; unset = as fast as possible
	tokenSize?: { min?: number; max?: number }; // chunk size in tokens (4 characters each)
	/** headers: only `x-session-id` (OpenRouter's cache affinity), when the request has it. */
	onRequest?: (request: { url: string; body: unknown; headers?: Record<string, string> }) => void;
	models?: OpenRouterModel[]; // the GET /models list
}

export interface FauxProvider {
	fetch: typeof globalThis.fetch;
	setResponses(responses: FauxResponse[]): void;
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** The text the usage chunk counts as output: text, thinking and tool-call arguments. */
function completionText(content: FauxContentBlock[]): string {
	return content
		.map((block) => {
			if (block.type === "text") return block.text;
			if (block.type === "thinking") return block.thinking;
			return JSON.stringify(block.arguments);
		})
		.join("");
}

function splitStringByTokenSize(text: string, minTokenSize: number, maxTokenSize: number): string[] {
	const chunks: string[] = [];
	let index = 0;
	while (index < text.length) {
		const tokenSize = minTokenSize + Math.floor(Math.random() * (maxTokenSize - minTokenSize + 1));
		const charSize = Math.max(1, tokenSize * 4);
		chunks.push(text.slice(index, index + charSize));
		index += charSize;
	}
	return chunks.length > 0 ? chunks : [""];
}

function scheduleChunk(chunk: string, tokensPerSecond: number | undefined): Promise<void> {
	if (!tokensPerSecond || tokensPerSecond <= 0) return new Promise((resolve) => setImmediate(resolve));
	return new Promise((resolve) => setTimeout(resolve, (estimateTokens(chunk) / tokensPerSecond) * 1000));
}

const FINISH_REASONS: Partial<Record<StopReason, string>> = { stop: "stop", length: "length", toolUse: "tool_calls" };

/**
 * The SSE response a Chat Completions endpoint sends for this message: a role chunk, the content
 * in random pieces, a finish chunk, a usage chunk, then [DONE]. Abort is checked between pieces.
 */
function streamWithDeltas(
	message: AssistantMessage | FauxBrokenStream,
	body: { model: string; messages: unknown },
	minTokenSize: number,
	maxTokenSize: number,
	tokensPerSecond: number | undefined,
	signal: AbortSignal | null | undefined,
): Response {
	const chunk = (delta: object, finishReason: string | null = null, usage?: object) => ({
		id: "chatcmpl-faux",
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: body.model,
		choices: usage ? [] : [{ index: 0, delta, finish_reason: finishReason }],
		...(usage ? { usage } : {}),
	});
	const promptTokens = estimateTokens(JSON.stringify(body.messages));
	const completionTokens = estimateTokens(completionText(message.content));
	const usage = {
		prompt_tokens: promptTokens,
		completion_tokens: completionTokens,
		total_tokens: promptTokens + completionTokens,
	};

	const encoder = new TextEncoder();
	const sse = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (data: object) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
			// Sends text in random pieces, each as the delta toDelta makes. False if the request was aborted.
			const sendPieces = async (text: string, toDelta: (piece: string) => object) => {
				for (const piece of splitStringByTokenSize(text, minTokenSize, maxTokenSize)) {
					await scheduleChunk(piece, tokensPerSecond);
					if (signal?.aborted) return false;
					send(chunk(toDelta(piece)));
				}
				return true;
			};

			send(chunk({ role: "assistant", content: "" }));
			let toolIndex = 0;
			for (const block of message.content) {
				let sent = true;
				if (block.type === "thinking") {
					// Reasoning comes in OpenRouter's `reasoning` delta field, before the answer.
					sent = await sendPieces(block.thinking, (piece) => ({ reasoning: piece }));
				} else if (block.type === "text") {
					sent = await sendPieces(block.text, (piece) => ({ content: piece }));
				} else if (block.type === "toolCall") {
					// A tool call: the first delta names it, then its arguments come as JSON text in pieces.
					const index = toolIndex++;
					send(
						chunk({
							tool_calls: [
								{ index, id: block.id, type: "function", function: { name: block.name, arguments: "" } },
							],
						}),
					);
					// edupi: `rawArguments` in a script streams malformed JSON as a model may send it.
					const argumentsText =
						(block as { rawArguments?: string }).rawArguments ?? JSON.stringify(block.arguments);
					sent = await sendPieces(argumentsText, (piece) => ({
						tool_calls: [{ index, function: { arguments: piece } }],
					}));
				}
				if (!sent) return controller.error(new Error("Request was aborted"));
			}
			if ("streamError" in message) return controller.error(new Error(message.streamError));
			send(chunk({}, FINISH_REASONS[message.stopReason] ?? "stop"));
			send(chunk({}, null, usage));
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			controller.close();
		},
	});
	return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export function fauxProvider(options: RegisterFauxProviderOptions = {}): FauxProvider {
	const minTokenSize = Math.max(
		1,
		Math.min(options.tokenSize?.min ?? DEFAULT_MIN_TOKEN_SIZE, options.tokenSize?.max ?? DEFAULT_MAX_TOKEN_SIZE),
	);
	const maxTokenSize = Math.max(minTokenSize, options.tokenSize?.max ?? DEFAULT_MAX_TOKEN_SIZE);
	let pendingResponses: FauxResponse[] = [];

	const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = String(input instanceof Request ? input.url : input);
		if ((init?.method ?? "GET") === "GET" && url.endsWith("/models"))
			return Response.json({ data: options.models ?? [] });
		const body = JSON.parse(String(init?.body ?? "null"));
		const sessionHeader = new Headers(init?.headers).get("x-session-id");
		options.onRequest?.({ url, body, ...(sessionHeader ? { headers: { "x-session-id": sessionHeader } } : {}) });
		const message = pendingResponses.shift();
		if (!message) {
			return Response.json({ error: { message: "No more faux responses queued" } }, { status: 500 });
		}
		if ("error" in message) {
			// The error body OpenAI-compatible endpoints send; OpenRouter adds the HTTP status as code.
			const status = message.error.status ?? 400;
			return Response.json({ error: { message: message.error.message, code: status } }, { status });
		}

		return streamWithDeltas(message, body, minTokenSize, maxTokenSize, options.tokensPerSecond, init?.signal);
	};

	return {
		fetch,
		setResponses(responses) {
			pendingResponses = [...responses];
		},
	};
}

type FauxScriptStep =
	| string
	| FauxError
	| { content: string | FauxContentBlock[]; stopReason?: StopReason; streamError?: string };

function toFauxResponse(step: FauxScriptStep): FauxResponse {
	if (typeof step === "string") return fauxAssistantMessage(step);
	if ("error" in step) return step;
	const message = fauxAssistantMessage(step.content, { stopReason: step.stopReason });
	return step.streamError !== undefined ? { ...message, streamError: step.streamError } : message;
}

// Reads a faux script: `{"models"?: [OpenRouter list items], "tokensPerSecond"?: n, "responses": [...]}`.
// A response is a text string, `{"content": string | blocks, "stopReason"?}` (fauxAssistantMessage's
// arguments, plus `"streamError"`: the stream breaks with this error before the finish chunk) or
// `{"error": {"status"?, "message"}}` (an HTTP error, e.g. a context overflow).
// Blocks: `{"type": "text", "text"}`, `{"type": "thinking", "thinking"}`,
// `{"type": "toolCall", "id", "name", "arguments", "rawArguments"?}` (rawArguments: text sent instead of the JSON).
export function loadFauxScript(path: string): {
	models: OpenRouterModel[];
	tokensPerSecond?: number;
	responses: FauxResponse[];
} {
	const script = JSON.parse(readFileSync(path, "utf8"));
	const responses = (script.responses as FauxScriptStep[]).map(toFauxResponse);
	return { models: script.models ?? [], tokensPerSecond: script.tokensPerSecond, responses };
}
