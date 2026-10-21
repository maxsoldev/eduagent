// Mirrors pi packages/ai/src/utils/transcript.ts (pinned 16f5f0af4), the tool part: in pi the
// tools the model may call are declared inside the transcript, as toolsAdded and toolsRemoved on
// system messages. Replaying those changes in order gives the current tool set.
// edupi leaves out the system-prompt replay helpers and the per-API tool placement.
import type { Tool, ToolReference } from "../types.ts";

type TranscriptMessages = readonly { role: string }[];

interface ToolDeclaringMessage {
  role: "system";
  toolsAdded?: Tool[];
  toolsRemoved?: ToolReference[];
}

const isSystemMessage = (message: { role: string }): message is ToolDeclaringMessage => message.role === "system";

/** The tools available after applying every transcript change in order. */
export function getCurrentTools(messages: TranscriptMessages): Tool[] {
  const tools = new Map<string, Tool>();
  for (const message of messages) {
    if (!isSystemMessage(message)) continue;
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
  }
  return [...tools.values()];
}

/** What the model sees of a tool: name, description and a plain-JSON copy of the schema. */
export function toToolDeclaration(tool: Tool): Tool {
  return { name: tool.name, description: tool.description, parameters: JSON.parse(JSON.stringify(tool.parameters)) };
}

/** Same interface to the model? The JSON round-trip drops typebox's symbol keys, so string comparison is exact. */
export function declarationsEqual(left: Tool, right: Tool): boolean {
  return JSON.stringify(toToolDeclaration(left)) === JSON.stringify(toToolDeclaration(right));
}

export interface ToolStateChanges {
  toolsAdded: Tool[];
  toolsRemoved: ToolReference[];
}

/** Compares two complete tool sets. A changed definition is a removal plus an addition. */
export function getToolStateChanges(previous: readonly Tool[], current: readonly Tool[]): ToolStateChanges {
  const previousTools = new Map(previous.map((tool) => [tool.name, tool]));
  const currentTools = new Map(current.map((tool) => [tool.name, tool]));
  return {
    toolsAdded: current
      .filter((tool) => {
        const previousTool = previousTools.get(tool.name);
        return previousTool === undefined || !declarationsEqual(previousTool, tool);
      })
      .map(toToolDeclaration),
    toolsRemoved: previous
      .filter((tool) => {
        const currentTool = currentTools.get(tool.name);
        return currentTool === undefined || !declarationsEqual(tool, currentTool);
      })
      .map((tool) => ({ name: tool.name })),
  };
}
