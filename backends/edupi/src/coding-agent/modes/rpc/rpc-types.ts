// Mirrors pi packages/coding-agent/src/modes/rpc/rpc-types.ts (pinned 16f5f0af4): the RPC
// commands (stdin) and responses (stdout). The names and shapes are pi's, unchanged.
// edupi has the commands below; pi's other commands get pi's "Unknown command" error.
import type { AgentMessage } from "../../../agent/types.ts";
import type { ImageContent, Model, ThinkingLevel } from "../../../ai/types.ts";
import type { PromptDisposition } from "../../core/agent-session.ts";

export type RpcCommand =
  | { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
  | { id?: string; type: "new_session"; parentSession?: string }
  | { id?: string; type: "get_state" }
  | { id?: string; type: "get_messages" };

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

export type RpcResponse =
  | { id?: string; type: "response"; command: "prompt"; success: true; data: { disposition: PromptDisposition } }
  | { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }
  | { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
  | { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }
  | { id?: string; type: "response"; command: string; success: false; error: string };
