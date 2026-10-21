// Mirrors pi packages/ai/src/api/transform-messages.ts (pinned 16f5f0af4): cleans the transcript
// before a provider converts it. Errored and aborted replies are left out, thinking from another
// model is dropped, and a tool call without a result gets a synthetic error result.
import type { AssistantMessage, Message, Model, ToolCall, ToolResultMessage } from "../types.ts";

/** pi's transformMessages, without image downgrades and tool call id normalization (OpenRouter needs neither). */
export function transformMessages(messages: Message[], model: Model): Message[] {
  // Normalize null/undefined content from untyped callers (hand-built histories, old session files).
  const normalizedMessages = messages.map((msg) => (msg.content == null ? { ...msg, content: [] } as Message : msg));

  // First pass: thinking blocks.
  const transformed = normalizedMessages.map((msg): Message => {
    if (msg.role !== "assistant") return msg;
    const isSameModel = msg.provider === model.provider && msg.api === model.api && msg.model === model.id;
    const content = msg.content.flatMap((block) => {
      if (block.type !== "thinking") return block;
      // Thinking from another model is dropped: the new model would read it as part of the visible reply.
      if (!isSameModel) return [];
      if (block.redacted || block.thinkingSignature) return block;
      if (!block.thinking || block.thinking.trim() === "") return [];
      return block;
    });
    return { ...msg, content };
  });

  // Second pass: insert synthetic empty tool results for orphaned tool calls.
  const result: Message[] = [];
  let pendingToolCalls: ToolCall[] = [];
  let existingToolResultIds = new Set<string>();
  // A system message between a tool call and its results waits until after the results.
  const heldSystemMessages: Message[] = [];
  const closePendingToolCalls = () => {
    for (const tc of pendingToolCalls) {
      if (!existingToolResultIds.has(tc.id)) {
        result.push({
          role: "toolResult",
          toolCallId: tc.id,
          toolName: tc.name,
          content: [{ type: "text", text: "No result provided" }],
          isError: true,
          timestamp: Date.now(),
        } as ToolResultMessage);
      }
    }
    pendingToolCalls = [];
    existingToolResultIds = new Set();
    result.push(...heldSystemMessages);
    heldSystemMessages.length = 0;
  };

  for (const msg of transformed) {
    if (msg.role === "assistant") {
      closePendingToolCalls();
      // Errored and aborted replies are incomplete turns (partial text, half a tool call):
      // replaying them can make the API refuse the request. The model goes on from the last valid state.
      const assistantMsg = msg as AssistantMessage;
      if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") continue;
      const toolCalls = assistantMsg.content.filter((b): b is ToolCall => b.type === "toolCall");
      if (toolCalls.length > 0) {
        pendingToolCalls = toolCalls;
        existingToolResultIds = new Set();
      }
      result.push(msg);
    } else if (msg.role === "toolResult") {
      existingToolResultIds.add(msg.toolCallId);
      result.push(msg);
    } else if (msg.role === "system") {
      if (pendingToolCalls.length > 0) heldSystemMessages.push(msg);
      else result.push(msg);
    } else {
      // A new user turn interrupts the tool flow: orphaned calls get their results first.
      closePendingToolCalls();
      result.push(msg);
    }
  }

  // The conversation may end with unresolved tool calls.
  closePendingToolCalls();
  return result;
}
