// Mirrors pi packages/coding-agent/src/modes/json-event.ts (pinned 16f5f0af4): the wire shape of
// session events in the JSON and RPC modes. Only message_update changes: the cumulative partial
// message is dropped (message_start and the deltas rebuild it), the usage so far stays, and
// toolcall_start gets the tool call's id and name.
import type { AssistantMessageEvent, Usage } from "../../ai/types.ts";
import type { AgentSessionEvent } from "../core/agent-session.ts";

type WithoutPartial<T> = T extends { partial: unknown } ? Omit<T, "partial"> : T;

export type JsonAssistantMessageEvent = WithoutPartial<AssistantMessageEvent> | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string };

export type JsonAgentSessionEvent =
  | Exclude<AgentSessionEvent, { type: "message_update" }>
  | { type: "message_update"; usage: Usage; assistantMessageEvent: JsonAssistantMessageEvent };

function toJsonAssistantMessageEvent(event: AssistantMessageEvent): JsonAssistantMessageEvent {
  if (event.type === "toolcall_start") {
    const toolCall = event.partial.content[event.contentIndex];
    if (toolCall?.type !== "toolCall") throw new Error(`toolcall_start content at index ${event.contentIndex} is not a tool call`);
    const { partial: _partial, ...deltaEvent } = event;
    return { ...deltaEvent, id: toolCall.id, toolName: toolCall.name };
  }
  if (!("partial" in event)) return event;
  const { partial: _partial, ...deltaEvent } = event;
  return deltaEvent;
}

export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent {
  if (event.type !== "message_update") return event;
  return { type: "message_update", usage: event.message.usage, assistantMessageEvent: toJsonAssistantMessageEvent(event.assistantMessageEvent) };
}
