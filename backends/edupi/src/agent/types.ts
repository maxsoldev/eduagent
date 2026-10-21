// Mirrors pi packages/agent/src/types.ts (pinned 16f5f0af4): the agent layer's types. The agent
// works with AgentMessages; only at the model call are they turned into provider Messages.
import type {
	AssistantMessage,
	AssistantMessageEvent,
	ImageContent,
	Message,
	Model,
	ProviderProbe,
	SimpleStreamOptions,
	TextContent,
	ThinkingLevel,
	Tool,
	ToolCall,
	ToolResultMessage,
	TranscriptContext,
} from "../ai/types.ts";
import type { AssistantMessageEventStream } from "../ai/utils/event-stream.ts";

export type { ThinkingLevel } from "../ai/types.ts";

/** Calls the model. Must not throw: failures end the stream with an `error` event. */
export type StreamFn = (
	model: Model,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/**
 * Apps add their own message roles by declaration merging into this interface. The coding
 * agent adds "compactionSummary" (coding-agent/core/messages.ts).
 */
export interface CustomAgentMessages {
	// Empty by default
}

/** The provider's messages plus the app's own. convertToLlm turns them into provider messages. */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/** "parallel" (pi's default): all tool calls of one reply run at once. "sequential": one after the other. */
export type ToolExecutionMode = "sequential" | "parallel";

export type AgentToolCall = ToolCall;

/**
 * edupi only (pi has none): the agent loop's hook points for the teaching extras. The provider
 * hooks come from the ai layer; coding-agent/core/probe.ts extends this with its own.
 */
export interface AgentProbe extends ProviderProbe {
	/** A tool call starts (after tool_execution_start). parallel: the reply's calls run at once. */
	toolDispatch?(call: { toolCall: AgentToolCall; parallel: boolean }): void | Promise<void>;
	/** A tool call ended (after tool_execution_end), with the result the model will read. */
	toolOutput?(outcome: {
		toolCall: AgentToolCall;
		result: AgentToolResult<unknown>;
		isError: boolean;
		durationMs?: number;
	}): void | Promise<void>;
	/**
	 * A point where step mode may pause the loop: the loop waits until the returned promise
	 * settles. signal is the run's abort signal, so an abort also ends the wait.
	 */
	checkpoint?(name: Checkpoint, info: Record<string, unknown>, signal?: AbortSignal): void | Promise<void>;
	/** A turn ended (after turn_end): does the loop call the model again? (educodex's loopIteration) */
	loopIteration?(iteration: LoopIteration): void | Promise<void>;
}

/** The loop's decision after one model reply. iteration counts the model calls of this run. */
export interface LoopIteration {
	iteration: number;
	/** The reply called tools, so the model must see their results. */
	needsFollowUp: boolean;
	message: AssistantMessage;
	decision: "continue" | "stop";
}

/** The loop's step-mode checkpoints (the same names as educodex's). */
export type Checkpoint = "beforeModelRequest" | "beforeToolCall" | "afterToolCall";

/** "one-at-a-time" (pi's default): a queue gives one message per drain point. "all": every queued message. */
export type QueueMode = "all" | "one-at-a-time";

export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model;
	/** AgentMessage[] to provider Message[], just before each model call. */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	/** Default "parallel". A tool with executionMode "sequential" makes the whole batch sequential. */
	toolExecution?: ToolExecutionMode;
	/** Steering messages to put in before the next model call. Polled at the loop's drain points. */
	getSteeringMessages?: () => Promise<AgentMessage[]>;
	/** Follow-up messages, polled only when the agent would stop. */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;
	probe?: AgentProbe;
	/**
	 * Called after a turn when the loop goes on, just before the next turn starts. The returned
	 * context, model and thinking level replace the loop's own; returned messages go in first
	 * (the coding agent compacts here, and picks up a model or level changed during the run).
	 */
	prepareNextTurn?: (
		turn: PrepareNextTurnContext,
	) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;
}

/** The turn that just ended, passed to prepareNextTurn. */
export interface PrepareNextTurnContext {
	message: AssistantMessage;
	toolResults: ToolResultMessage[];
	/** The loop's context, with the reply and its tool results in it. */
	context: AgentContext;
	/** The messages this run has added so far. */
	newMessages: AgentMessage[];
}

/** What prepareNextTurn may replace for the next model call. */
export interface AgentLoopTurnUpdate {
	context?: AgentContext;
	/** Messages to put in before the next model call, with message events. */
	messages?: AgentMessage[];
	model?: Model;
	thinkingLevel?: ThinkingLevel;
}

export interface AgentState {
	model: Model;
	thinkingLevel: ThinkingLevel;
	tools: AgentTool<any>[];
	messages: AgentMessage[];
	readonly isStreaming: boolean;
	readonly streamingMessage?: AgentMessage;
	/** Ids of the tool calls that are running now. */
	readonly pendingToolCalls: ReadonlySet<string>;
	readonly errorMessage?: string;
}

/** What a tool returns. content goes to the model; details are for the user interface only. */
export interface AgentToolResult<T> {
	content: (TextContent | ImageContent)[];
	details: T;
	/** The result as data, for programmatic callers (pi's codemode). Not sent to the model. */
	structuredContent?: unknown;
	/** true: the model reads the result as a failure. */
	isError?: boolean;
}

/** Partial results of a running tool: each call replaces the previous one. */
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

/** A tool the agent can run: the model-facing Tool plus the code that executes it. */
export interface AgentTool<TParams = any, TDetails = any> extends Tool {
	label: string;
	/** Repairs common argument mistakes before validation (pi's edit takes a JSON-string edits field). */
	prepareArguments?: (args: unknown) => unknown;
	/** Throw to fail: the error message becomes the tool result. */
	execute: (
		toolCallId: string,
		params: TParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
	executionMode?: ToolExecutionMode;
}

/** The transcript one run starts from, and the tools it may run. */
export interface AgentContext {
	messages: AgentMessage[];
	tools?: AgentTool<any>[];
}

/** Events the agent emits. A turn is one assistant response plus its tool calls. */
export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; message: AssistantMessage; assistantMessageEvent: AssistantMessageEvent } // assistant only
	| { type: "message_end"; message: AgentMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: any;
			partialResult: AgentToolResult<any>;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: AgentToolResult<any>;
			isError: boolean;
			durationMs?: number;
	  };
