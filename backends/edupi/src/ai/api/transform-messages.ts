// Mirrors pi packages/ai/src/api/transform-messages.ts (pinned 16f5f0af4): cleans the transcript
// before a provider converts it. Errored and aborted replies are left out, thinking from another
// model is dropped, and a tool call without a result gets a synthetic error result.
import type { AssistantMessage, Message, Model, ToolCall, ToolResultMessage } from "../types.ts";

/**
 * pi's transformMessages, without image downgrades and tool call id normalization (OpenRouter
 * needs neither), and without holding back system messages between a tool call and its results
 * (edupi collapses the system messages before this runs).
 */
export function transformMessages(messages: Message[], model: Model): Message[] {
	// First pass: thinking blocks.
	const transformed = messages.map((msg): Message => {
		if (msg.role !== "assistant") return msg;
		const isSameModel = msg.provider === model.provider && msg.api === model.api && msg.model === model.id;
		const content = msg.content.flatMap((block) => {
			if (block.type !== "thinking") return block;
			// Thinking from another model is dropped: the new model would read it as part of the visible reply.
			if (!isSameModel) return [];
			if (block.thinkingSignature) return block;
			if (!block.thinking || block.thinking.trim() === "") return [];
			return block;
		});
		return { ...msg, content };
	});

	// Second pass: insert synthetic empty tool results for orphaned tool calls.
	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();
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
	};

	for (const msg of transformed) {
		if (msg.role === "assistant") {
			closePendingToolCalls();
			// Errored and aborted replies are incomplete turns (partial text, half a tool call):
			// replaying them can make the API refuse the request. The model goes on from the last valid state.
			const assistantMsg = msg as AssistantMessage;
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") continue;
			const toolCalls = assistantMsg.content.filter((b): b is ToolCall => b.type === "toolCall");
			if (toolCalls.length > 0) pendingToolCalls = toolCalls;
			result.push(msg);
		} else if (msg.role === "toolResult") {
			existingToolResultIds.add(msg.toolCallId);
			result.push(msg);
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
