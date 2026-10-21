// Mirrors pi packages/ai/src/utils/text.ts and transcript.ts (pinned 16f5f0af4): helpers for
// message content and for the system messages inside a transcript.
import type { ImageContent, SystemMessage, TextContent, ThinkingContent, Tool, ToolCall } from "../types.ts";

type Content = TextContent | ImageContent | ThinkingContent | ToolCall;

/** The text blocks of some content, joined. */
export function contentText(content: string | readonly Content[], separator = "\n"): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join(separator);
}

/**
 * Replays every system message into one: later content is appended, sections are patched by
 * name (null removes one), tools are merged by name. Undefined if there is no system message.
 */
export function getCurrentSystemMessage(messages: readonly { role: string }[]): SystemMessage | undefined {
  const content: string[] = [];
  const sections = new Map<string, string>();
  const tools = new Map<string, Tool>();
  let timestamp: number | undefined;
  for (const message of messages) {
    if (message.role !== "system") continue;
    const system = message as SystemMessage;
    timestamp ??= system.timestamp;
    const text = contentText(system.content);
    if (text.length > 0) content.push(text);
    for (const [name, value] of Object.entries(system.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
    for (const tool of system.toolsAdded ?? []) tools.set(tool.name, tool);
  }
  if (timestamp === undefined && tools.size === 0) return undefined;
  return {
    role: "system",
    content: content.join("\n\n"),
    ...(sections.size > 0 ? { sections: Object.fromEntries(sections) } : {}),
    ...(tools.size > 0 ? { toolsAdded: [...tools.values()] } : {}),
    timestamp: timestamp ?? 0,
  };
}
