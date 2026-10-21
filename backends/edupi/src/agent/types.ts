// Mirrors pi packages/agent/src/types.ts (pinned 16f5f0af4): the agent layer's types. The agent
// works with AgentMessages; only at the model call are they turned into provider Messages.
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Message,
  Model,
  SimpleStreamOptions,
  ThinkingLevel,
  ToolResultMessage,
  TranscriptContext,
} from "../ai/types.ts";
import type { AssistantMessageEventStream } from "../ai/utils/event-stream.ts";

export type { ThinkingLevel } from "../ai/types.ts";

/** Calls the model. Must not throw: failures end the stream with an `error` event. */
export type StreamFn = (model: Model, context: TranscriptContext, options?: SimpleStreamOptions) =>
  AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/** pi lets apps add their own message roles; edupi uses only the provider's. */
export type AgentMessage = Message;

export interface AgentLoopConfig extends SimpleStreamOptions {
  model: Model;
  /** AgentMessage[] to provider Message[], just before each model call. */
  convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
}

export interface AgentState {
  model: Model;
  thinkingLevel: ThinkingLevel;
  messages: AgentMessage[];
  readonly isStreaming: boolean;
  readonly streamingMessage?: AgentMessage;
  readonly errorMessage?: string;
}

/** The transcript one run starts from. */
export interface AgentContext {
  messages: AgentMessage[];
}

/** Events the agent emits. A turn is one assistant response plus its tool calls. */
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AssistantMessage; assistantMessageEvent: AssistantMessageEvent } // assistant only
  | { type: "message_end"; message: AgentMessage };
