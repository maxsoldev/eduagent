// Mirrors pi packages/ai/src/types.ts (pinned 16f5f0af4): the messages, content blocks, usage,
// model and stream event types that every layer above the provider uses.
// edupi keeps one API ("openai-completions") and one provider ("openrouter"), so Api and
// ProviderId are plain strings and Model has no per-API compat generics.
import type { TSchema } from "typebox";

export type Api = string; // edupi: always "openai-completions"
export type ProviderId = string; // edupi: always "openrouter"

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string; // the Chat Completions field the reasoning came in, for replay
	redacted?: boolean;
}

export interface ImageContent {
	type: "image";
	data: string; // base64
	mimeType: string;
}

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: JsonObject;
	argumentsError?: string;
}

export interface Usage {
	input: number;
	output: number; // includes reasoning tokens
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";

/** A tool as the model sees it: name, description and a typebox schema (plain JSON Schema) for the arguments. */
export interface Tool {
	name: string;
	description: string;
	parameters: TSchema;
}

/** A tool named in toolsRemoved. */
export interface ToolReference {
	name: string;
}

/**
 * System prompt and tool declarations at one point in the transcript. pi keeps the system
 * prompt inside the transcript as a message, not beside it.
 */
export interface SystemMessage {
	role: "system";
	content: string | TextContent[];
	sections?: Record<string, string | null>;
	toolsAdded?: Tool[];
	toolsRemoved?: ToolReference[];
	timestamp: number;
}

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	provider: ProviderId;
	model: string;
	responseModel?: string;
	responseId?: string;
	thinkingLevel?: ThinkingLevel; // set by the agent loop: the level it asked for
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	rawStopReason?: string;
	timestamp: number; // when the request started (Unix ms)
	durationMs?: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: JsonValue;
	isError: boolean;
	timestamp: number;
	durationMs?: number;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

/** The transcript a provider gets: system messages carry the prompt and the tools. */
export interface TranscriptContext {
	messages: Message[];
}

/** USD per million tokens. */
export interface ModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface Model {
	id: string;
	name: string;
	api: Api;
	provider: ProviderId;
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: ModelCost;
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string>;
}

/** Options for one model request (pi: ProviderRequestOptions + StreamOptions + SimpleStreamOptions). */
export interface SimpleStreamOptions {
	signal?: AbortSignal;
	apiKey?: string;
	headers?: Record<string, string>;
	fetch?: typeof globalThis.fetch; // edupi's faux provider replaces the HTTP call here
	maxTokens?: number;
	temperature?: number;
	sessionId?: string;
	reasoning?: Exclude<ThinkingLevel, "off">;
	/** Sees (and may replace) the request body before it is sent. Return undefined to keep it. */
	onPayload?: (payload: unknown, model: Model) => unknown | undefined | Promise<unknown | undefined>;
	probe?: ProviderProbe; // edupi: teaching hooks (pi's nearest are onPayload and onResponse)
}

/**
 * edupi's hook points in a provider: the request body as sent, each raw streamed chunk, and the
 * final response. pi has no such hooks. edupi's observe layer turns them into trace events;
 * the provider works the same without them.
 */
export interface ProviderProbe {
	/** sessionId: the session the request belongs to (not part of the body). */
	modelRequest?(request: { api: Api; url: string; body: unknown }, sessionId?: string): void | Promise<void>;
	streamEvent?(event: unknown): void | Promise<void>;
	modelResponse?(message: AssistantMessage): void | Promise<void>;
}

/**
 * Events of one streamed assistant response. `start` comes first, `done` or `error` last.
 * `partial` is the response so far.
 */
export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };
