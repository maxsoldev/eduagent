// Mirrors pi packages/coding-agent/src/core/messages.ts (pinned 16f5f0af4): the coding agent's
// own message roles, and convertToLlm, which turns the AgentMessages of the context into the
// provider's Messages just before each model call. edupi has one own role, compactionSummary
// (pi also has bashExecution, custom and branchSummary).
import type { AgentMessage } from "../../agent/types.ts";
import type { Message } from "../../ai/types.ts";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

/** Stands for the compacted part of the conversation. Built from a compaction entry, never saved as a message. */
export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

declare module "../../agent/types.ts" {
	interface CustomAgentMessages {
		compactionSummary: CompactionSummaryMessage;
	}
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
): CompactionSummaryMessage {
	return { role: "compactionSummary", summary, tokensBefore, timestamp: new Date(timestamp).getTime() };
}

export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.map((m): Message | undefined => {
			switch (m.role) {
				case "compactionSummary":
					// The model gets the summary as a user message.
					return {
						role: "user",
						content: [
							{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX },
						],
						timestamp: m.timestamp,
					};
				case "system":
				case "user":
				case "assistant":
				case "toolResult":
					return m;
				default:
					return undefined;
			}
		})
		.filter((m) => m !== undefined);
}
