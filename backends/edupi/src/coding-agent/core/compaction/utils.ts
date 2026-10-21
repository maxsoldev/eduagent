// Mirrors pi packages/coding-agent/src/core/compaction/utils.ts (pinned 16f5f0af4): the file lists
// a summary carries, the conversation as plain text, and the summarizer's system prompt.
import type { AgentMessage } from "../../../agent/types.ts";
import type { Message } from "../../../ai/types.ts";
import { contentText } from "../../../ai/utils/transcript.ts";

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export function createFileOps(): FileOperations {
	return { read: new Set(), written: new Set(), edited: new Set() };
}

/** The paths of read, write and edit tool calls in an assistant message. */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		const path = typeof block.arguments?.path === "string" ? block.arguments.path : undefined;
		if (!path) continue;
		if (block.name === "read") fileOps.read.add(path);
		else if (block.name === "write") fileOps.written.add(path);
		else if (block.name === "edit") fileOps.edited.add(path);
	}
}

/** readFiles: files only read, not modified. modifiedFiles: written or edited. Both sorted. */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	return { readFiles: readOnly, modifiedFiles: [...modified].sort() };
}

/** The file lists as XML tags, appended to the summary. */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

/** Maximum characters for a tool result in serialized summaries. */
const TOOL_RESULT_MAX_CHARS = 2000;

function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`;
}

/**
 * The conversation as plain text, so the summarizer reads it instead of continuing it. Thinking
 * is left out; tool results are cut to 2000 characters.
 */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];
	for (const msg of messages) {
		if (msg.role === "user") {
			const content = contentText(msg.content, "");
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			const toolCalls: string[] = [];
			for (const block of msg.content) {
				if (block.type === "toolCall") {
					const argsStr = Object.entries(block.arguments)
						.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}
			if (msg.content.some((block) => block.type === "text")) parts.push(`[Assistant]: ${contentText(msg.content)}`);
			if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
		} else if (msg.role === "toolResult") {
			const content = contentText(msg.content, "");
			if (content) parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
		}
	}
	return parts.join("\n\n");
}

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
