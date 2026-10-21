// Mirrors pi packages/ai/src/utils/transcript.ts and text.ts (pinned 16f5f0af4). pi keeps the system
// prompt and the model's tools on system messages in the transcript: `sections` patch the prompt by
// name, toolsAdded and toolsRemoved change the tools. Replayed in order, they give the current tools
// and system message (the request starts with it; a compaction entry stores it).
// edupi leaves out the per-API tool placement (pi's Kimi-style mid-conversation tool messages).
import type {
	ImageContent,
	Message,
	SystemMessage,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolReference,
	TranscriptContext,
} from "../types.ts";

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

/** What the model sees of a tool: name, description, a plain-JSON copy of the schema and its sampling setting. */
export function toToolDeclaration(tool: Tool): Tool {
	return {
		name: tool.name,
		description: tool.description,
		parameters: JSON.parse(JSON.stringify(tool.parameters)),
		...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }),
	};
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

type Content = TextContent | ImageContent | ThinkingContent | ToolCall;

/** The text blocks of some content, joined (pi's utils/text.ts). */
export function contentText(content: string | readonly Content[], separator = "\n"): string {
	if (typeof content === "string") return content;
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(separator);
}

/**
 * Replays every system message into one: later content is appended, sections are patched by
 * name (null removes one), tools come from getCurrentTools. Undefined if there is none.
 */
export function getCurrentSystemMessage(messages: TranscriptMessages): SystemMessage | undefined {
	const content: string[] = [];
	const sections = new Map<string, string>();
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
	}
	const tools = getCurrentTools(messages);
	if (timestamp === undefined && tools.length === 0) return undefined;
	return {
		role: "system",
		content: content.join("\n\n"),
		...(sections.size > 0 ? { sections: Object.fromEntries(sections) } : {}),
		...(tools.length > 0 ? { toolsAdded: tools } : {}),
		timestamp: timestamp ?? 0,
	};
}

/** A system message as one prompt text: its content, then its sections (pi's utils/text.ts). */
export function getSystemMessageText(message: SystemMessage): string {
	const parts = [contentText(message.content)];
	for (const text of Object.values(message.sections ?? {})) {
		if (text !== null) parts.push(text);
	}
	return parts.filter((part) => part.length > 0).join("\n\n");
}

/**
 * For APIs without mid-conversation system messages (OpenRouter's Chat Completions in pi): the
 * replayed system message leads, and every later system message is dropped.
 */
export function collapseSystemMessages(context: TranscriptContext): TranscriptContext {
	const head = getCurrentSystemMessage(context.messages);
	const messages = context.messages.filter((message) => message.role !== "system");
	return { messages: head ? [head, ...messages] : messages } as { messages: Message[] };
}
