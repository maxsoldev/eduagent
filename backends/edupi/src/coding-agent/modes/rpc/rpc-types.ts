// Mirrors pi packages/coding-agent/src/modes/rpc/rpc-types.ts (pinned 16f5f0af4): the RPC
// commands (stdin) and responses (stdout). The names and shapes are pi's, unchanged.
// edupi has the commands below; pi's other commands get pi's "Unknown command" error.
import type { AgentMessage } from "../../../agent/types.ts";
import type { ImageContent, Model, ThinkingLevel } from "../../../ai/types.ts";
import type { PromptDisposition, QueuedInputDisposition } from "../../core/agent-session.ts";
import type { CompactionResult } from "../../core/compaction/compaction.ts";
import type { SourceInfo } from "../../core/skills.ts";

export type RpcCommand =
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "new_session" }
	| { id?: string; type: "get_state" }
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "get_commands" }
	// edupi only (not in pi): the teaching extras' debug_ commands.
	| { id?: string; type: "debug_set_step_mode"; enabled: boolean; breakpoints?: string[] }
	| { id?: string; type: "debug_continue" }
	| { id?: string; type: "debug_get_context" };

/** A slash command the user can type. edupi has only skill commands (pi also has extension and prompt-template commands). */
export interface RpcSlashCommand {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
	sourceInfo: SourceInfo;
}

export interface RpcSessionState {
	model?: Model;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
}

/** edupi only: debug_get_context's reply. body is the next Chat Completions request body. */
export interface RpcDebugContext {
	body: object;
	messageCount: number;
	tokens: number;
	contextWindow: number;
	autoCompactLimit: number;
}

export type RpcResponse =
	| { id?: string; type: "response"; command: "prompt"; success: true; data: { disposition: PromptDisposition } }
	| { id?: string; type: "response"; command: "steer"; success: true; data: { disposition: QueuedInputDisposition } }
	| {
			id?: string;
			type: "response";
			command: "follow_up";
			success: true;
			data: { disposition: QueuedInputDisposition };
	  }
	| { id?: string; type: "response"; command: "abort" | "set_thinking_level"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "get_commands"; success: true; data: { commands: RpcSlashCommand[] } }
	| {
			id?: string;
			type: "response";
			command: "debug_set_step_mode";
			success: true;
			data: { enabled: boolean; breakpoints: string[] };
	  }
	| { id?: string; type: "response"; command: "debug_continue"; success: true }
	| { id?: string; type: "response"; command: "debug_get_context"; success: true; data: RpcDebugContext }
	| { id?: string; type: "response"; command: string; success: false; error: string };
