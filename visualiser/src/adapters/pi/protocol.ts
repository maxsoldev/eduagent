// pi's RPC wire types, imported from edupi (backends/edupi), which keeps pi's names and shapes
// (packages/coding-agent/src/modes/rpc/rpc-types.ts and modes/json-event.ts at the pinned commit).
// Real pi sends more event types than edupi has; the mapping ignores the ones it does not know.
import type { RpcResponse, RpcSessionState, RpcSlashCommand } from "@eduagent/edupi/rpc-types";
import type { JsonAgentSessionEvent } from "@eduagent/edupi/json-event";

export type { AgentMessage, AgentToolResult } from "@eduagent/edupi/agent-types";
export type { ImageContent, TextContent, ThinkingLevel, ToolResultMessage } from "@eduagent/edupi/ai-types";
export type { JsonAgentSessionEvent, RpcResponse, RpcSessionState, RpcSlashCommand };

/** edupi's teaching extras: {type: "trace", name, ...payload} (protocol/README.md section 6). */
export type PiTrace = { type: "trace"; name: string; [field: string]: unknown };

/** One line from pi's stdout: a reply to a command, an event, or (edupi only) a trace event. */
export type PiMessage = RpcResponse | JsonAgentSessionEvent | PiTrace;
