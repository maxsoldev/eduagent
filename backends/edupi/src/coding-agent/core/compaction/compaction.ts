// Mirrors pi packages/coding-agent/src/core/compaction/compaction.ts (pinned 16f5f0af4): context
// compaction. Pure functions: count the context's tokens, decide when to compact, find the cut
// point, and ask the model for a summary of everything before it. The session manager stores
// the result as a compaction entry; AgentSession decides when to run it.
import type { AgentMessage, StreamFn, ThinkingLevel } from "../../../agent/types.ts";
import type {
	AssistantMessage,
	Model,
	SimpleStreamOptions,
	SystemMessage,
	TranscriptContext,
	Usage,
} from "../../../ai/types.ts";
import { contentText, getCurrentSystemMessage } from "../../../ai/utils/transcript.ts";
import { uuidv7 } from "../../../ai/utils/uuid.ts";
import { convertToLlm } from "../messages.ts";
import {
	buildSessionProjection,
	type CompactionEntry,
	type ProjectedSessionEntry,
	type SessionEntry,
	type SessionProjection,
} from "../session-manager.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.ts";

// ============================================================================
// File Operation Tracking
// ============================================================================

/** Details stored in CompactionEntry.details for file tracking */
export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

/** The files of the previous compaction (its details), plus those of the tool calls in messages. */
function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();
	const prevCompaction = entries[prevCompactionIndex] as CompactionEntry | undefined;
	const details = prevCompaction?.details as CompactionDetails | undefined;
	if (details) {
		for (const f of details.readFiles) fileOps.read.add(f);
		for (const f of details.modifiedFiles) fileOps.edited.add(f);
	}
	for (const msg of messages) extractFileOpsFromMessage(msg, fileOps);
	return fileOps;
}

/** The conversation messages of an entry. System messages are prompt state: the compaction entry replays them. */
function getMessagesFromProjectedEntryForCompaction(entry: ProjectedSessionEntry): AgentMessage[] {
	if (entry.sourceEntry.type === "compaction") return [];
	return entry.messages.filter((message) => message.role !== "system");
}

/** What compact() returns; the session manager adds id and parentId when it saves it. */
export interface CompactionResult {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	estimatedTokensAfter?: number;
	usage?: Usage; // of the summary call(s)
	details?: CompactionDetails;
}

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number; // room left for the reply: compact above contextWindow - reserveTokens
	keepRecentTokens: number; // how much recent conversation is kept word for word
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

// ============================================================================
// Token calculation
// ============================================================================

/** The context size a response reports: totalTokens, or the sum of its parts. */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** An assistant message's usage, unless it was aborted, failed or reports nothing. */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role !== "assistant" || msg.stopReason === "aborted" || msg.stopReason === "error") return undefined;
	return calculateContextTokens(msg.usage) > 0 ? msg.usage : undefined;
}

interface ContextUsageEstimate {
	tokens: number;
	lastUsageIndex: number | null; // the message whose usage the estimate starts from
}

/** The last reported usage plus an estimate of every message after it (or an estimate of all). */
function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const index = messages.findLastIndex((message) => getAssistantUsage(message) !== undefined);
	let tokens = index >= 0 ? calculateContextTokens(getAssistantUsage(messages[index])!) : 0;
	for (let i = index + 1; i < messages.length; i++) tokens += estimateTokens(messages[i]);
	return { tokens, lastUsageIndex: index >= 0 ? index : null };
}

/** True if the entry of the message at lastUsageIndex comes after the latest context edit or compaction. */
function isUsageAfterLatestContextChange(
	projection: SessionProjection,
	branchEntries: SessionEntry[],
	lastUsageIndex: number,
): boolean {
	// The entry that produced each projected message, and so the one at lastUsageIndex.
	const messageEntryIds = projection.entries.flatMap((entry) => entry.messages.map(() => entry.sourceEntry.id));
	const usageEntryId = messageEntryIds[lastUsageIndex];
	const usageEntryIndex = branchEntries.findIndex((entry) => entry.id === usageEntryId);
	const latestChangeIndex = branchEntries.findLastIndex(
		(entry) => entry.type === "context_edit" || entry.type === "compaction",
	);
	return usageEntryIndex > latestChangeIndex;
}

/**
 * Like estimateContextTokens, but a usage reported before the latest context edit or compaction
 * describes an older, bigger context. Then every message is estimated instead.
 */
export function estimateProjectedContextTokens(
	projection: SessionProjection,
	branchEntries: SessionEntry[],
): ContextUsageEstimate {
	const estimate = estimateContextTokens(projection.messages);
	if (
		estimate.lastUsageIndex !== null &&
		isUsageAfterLatestContextChange(projection, branchEntries, estimate.lastUsageIndex)
	) {
		return estimate;
	}

	// Only the current system message is sent; older ones are prompt history.
	const currentSystem = getCurrentSystemMessage(projection.messages);
	let tokens = currentSystem ? estimateTokens(currentSystem) : 0;
	for (const message of projection.messages) if (message.role !== "system") tokens += estimateTokens(message);
	return { tokens, lastUsageIndex: null };
}

/** pi's threshold rule: compact when the context leaves less than reserveTokens of the window. */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}

// ============================================================================
// Cut point detection
// ============================================================================

/** A message's tokens, estimated as characters / 4 (an overestimate). */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;
	switch (message.role) {
		case "system": {
			const system = message as SystemMessage;
			chars = contentText(system.content, "").length;
			for (const section of Object.values(system.sections ?? {})) if (section) chars += section.length;
			if (system.toolsAdded) chars += JSON.stringify(system.toolsAdded).length;
			return Math.ceil(chars / 4);
		}
		case "user":
		case "toolResult":
			return Math.ceil(contentText(message.content, "").length / 4);
		case "assistant": {
			for (const block of message.content) {
				if (block.type === "text") chars += block.text.length;
				else if (block.type === "thinking") chars += block.thinking.length;
				else if (block.type === "toolCall") chars += block.name.length + JSON.stringify(block.arguments).length;
			}
			return Math.ceil(chars / 4);
		}
		case "compactionSummary":
			return Math.ceil(message.summary.length / 4);
	}
	return 0;
}

/** Where a cut may go: at a user, assistant or summary message, never at a tool result. */
function isCutPointMessage(message: AgentMessage): boolean {
	return message.role === "user" || message.role === "assistant" || message.role === "compactionSummary";
}

/** A turn starts with a user (or summary) message. */
function isTurnStartMessage(message: AgentMessage): boolean {
	return message.role === "user" || message.role === "compactionSummary";
}

interface CutPointResult {
	firstKeptEntryIndex: number; // index of the first entry to keep
	turnStartIndex: number; // the user message that starts the turn being split, or -1
	isSplitTurn: boolean; // the cut is inside a turn, not at its user message
}

// ============================================================================
// Summarization
// ============================================================================

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`;

/** An error or a length stop (partial text) must not become a checkpoint. */
function getSummarizationFailure(response: AssistantMessage, label: string): string | undefined {
	if (response.stopReason === "error") return `${label} failed: ${response.errorMessage || "Unknown error"}`;
	if (response.stopReason === "length")
		return `${label} failed: generation hit the token cap and the summary is incomplete`;
	return undefined;
}

/** edupi: what every summary call needs (pi passes these as separate arguments). */
interface SummarizationCall {
	model: Model;
	apiKey: string | undefined;
	streamFn: StreamFn;
	signal?: AbortSignal;
	thinkingLevel?: ThinkingLevel;
	onPayload?: SimpleStreamOptions["onPayload"];
}

/**
 * One summary call, through the agent's stream function: the summarizer's system prompt and one
 * user message. The model's own output limit, the session's thinking level if it reasons, no cache
 * writes and a fresh session id (pi compaction.ts:628). Fails on an error, a length stop or a tool call.
 */
async function completeSummarization(
	call: SummarizationCall,
	promptText: string,
	label: string,
): Promise<{ text: string; usage: Usage }> {
	const { model, thinkingLevel } = call;
	const context: TranscriptContext = {
		messages: [
			{ role: "system", content: SUMMARIZATION_SYSTEM_PROMPT, timestamp: Date.now() },
			{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() },
		],
	};
	const options: SimpleStreamOptions = {
		signal: call.signal,
		apiKey: call.apiKey,
		onPayload: call.onPayload,
		cacheRetention: "none",
		sessionId: uuidv7(),
	};
	if (model.reasoning && thinkingLevel && thinkingLevel !== "off") options.reasoning = thinkingLevel;

	const response = await (await call.streamFn(model, context, options)).result();
	const failure = getSummarizationFailure(response, label);
	if (failure) throw new Error(failure);
	if (response.content.some((block) => block.type === "toolCall"))
		throw new Error(`${label} attempted to call a tool`);
	return { text: contentText(response.content), usage: response.usage };
}

/** Summarizes messages, or folds them into previousSummary with the update prompt. */
async function generateSummaryWithUsage(
	currentMessages: AgentMessage[],
	call: SummarizationCall,
	customInstructions?: string,
	previousSummary?: string,
): Promise<{ text: string; usage: Usage }> {
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (customInstructions) basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;

	// Serialize the conversation to text, so the model does not try to continue it.
	const conversationText = serializeConversation(convertToLlm(currentMessages));
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	promptText += basePrompt;
	return completeSummarization(call, promptText, "Summarization");
}

// ============================================================================
// Compaction Preparation
// ============================================================================

export interface CompactionPreparation {
	firstKeptEntryId: string;
	messagesToSummarize: AgentMessage[]; // summarized and dropped from the context
	turnPrefixMessages: AgentMessage[]; // the first part of a split turn, summarized on its own
	isSplitTurn: boolean;
	tokensBefore: number;
	previousSummary?: string; // of the previous compaction, for the update prompt
	fileOps: FileOperations;
}

function isProjectedTurnStart(entry: ProjectedSessionEntry): boolean {
	if (entry.sourceEntry.type === "compaction") return false;
	return entry.messages.some(isTurnStartMessage);
}

function findProjectedTurnStartIndex(entries: ProjectedSessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) if (isProjectedTurnStart(entries[i])) return i;
	return -1;
}

/**
 * True if the entries after the cut hold only an omitted assistant reply (an overflow recovery
 * attempt) and the context edits that omit it: nothing there is still sent to the model.
 */
function isRecoveryOmissionSuffix(suffix: ProjectedSessionEntry[]): boolean {
	return (
		suffix.some(
			(entry) =>
				entry.sourceEntry.type === "message" &&
				entry.sourceEntry.message.role === "assistant" &&
				entry.messages.length === 0,
		) && suffix.every((entry) => entry.sourceEntry.type !== "compaction" && entry.messages.length === 0)
	);
}

/**
 * Walks back from the newest entry, adding up estimated tokens, until keepRecentTokens is reached.
 * The cut goes at the nearest cut point at or after that entry. If it is not a turn's user message,
 * the turn is split: its first part (the prefix) gets a summary of its own.
 */
function findProjectedCutPoint(
	entries: ProjectedSessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		if (entry.sourceEntry.type !== "compaction" && entry.messages.some(isCutPointMessage)) cutPoints.push(i);
	}
	if (cutPoints.length === 0) return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };

	let accumulatedTokens = 0;
	let exceededBudget = false;
	let cutIndex = cutPoints[0];
	for (let i = endIndex - 1; i >= startIndex; i--) {
		const messageTokens = entries[i].messages.reduce((sum, message) => sum + estimateTokens(message), 0);
		if (messageTokens === 0) continue;
		accumulatedTokens += messageTokens;
		if (accumulatedTokens >= keepRecentTokens) {
			exceededBudget = true;
			cutIndex = cutPoints.find((candidate) => candidate >= i) ?? cutPoints[cutPoints.length - 1];
			break;
		}
	}

	// After an overflow the cut moves one entry on, past the last input: it goes into the summary
	// (a split turn), so the retry does not send the input that overflowed again.
	if (exceededBudget && isRecoveryOmissionSuffix(entries.slice(cutIndex + 1, endIndex))) cutIndex++;

	// Keep the settings entries just before the cut with it.
	while (cutIndex > startIndex) {
		const previous = entries[cutIndex - 1];
		if (previous.sourceEntry.type === "compaction" || previous.messages.length > 0) break;
		cutIndex--;
	}
	const startsTurn = isProjectedTurnStart(entries[cutIndex]);
	const turnStartIndex = startsTurn ? -1 : findProjectedTurnStartIndex(entries, cutIndex, startIndex);
	return { firstKeptEntryIndex: cutIndex, turnStartIndex, isSplitTurn: !startsTurn && turnStartIndex !== -1 };
}

/**
 * Decides what to summarize. Only entries after the previous compaction count; its summary is
 * updated instead. Undefined if there is nothing to summarize (the session is too small, or the
 * last entry is a compaction).
 */
export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
): CompactionPreparation | undefined {
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") return undefined;

	const projection = buildSessionProjection(pathEntries);
	const projectedEntries = projection.entries;
	const sourceEntries = projectedEntries.map((entry) => entry.sourceEntry);
	// The newest compaction is projected first; older ones in its kept range add nothing.
	const prevCompactionIndex = projectedEntries.findIndex(
		(entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0,
	);

	let previousSummary: string | undefined;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		previousSummary = (projectedEntries[prevCompactionIndex].sourceEntry as CompactionEntry).summary;
		boundaryStart = prevCompactionIndex + 1;
	}
	const boundaryEnd = projectedEntries.length;
	const tokensBefore = estimateProjectedContextTokens(projection, pathEntries).tokens;
	const cutPoint = findProjectedCutPoint(projectedEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);

	const firstKeptEntry = projectedEntries[cutPoint.firstKeptEntryIndex]?.sourceEntry;
	if (!firstKeptEntry?.id) return undefined;
	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

	const messagesToSummarize = projectedEntries
		.slice(boundaryStart, historyEnd)
		.flatMap(getMessagesFromProjectedEntryForCompaction);
	const turnPrefixMessages = cutPoint.isSplitTurn
		? projectedEntries
				.slice(cutPoint.turnStartIndex, cutPoint.firstKeptEntryIndex)
				.flatMap(getMessagesFromProjectedEntryForCompaction)
		: [];
	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) return undefined;

	const fileOps = extractFileOperations(messagesToSummarize, sourceEntries, prevCompactionIndex);
	if (cutPoint.isSplitTurn) for (const msg of turnPrefixMessages) extractFileOpsFromMessage(msg, fileOps);

	return {
		firstKeptEntryId: firstKeptEntry.id,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
	};
}

// ============================================================================
// Main compaction function
// ============================================================================

const TURN_PREFIX_SUMMARIZATION_PROMPT = `The messages above are earlier context from an ongoing conversation. Later messages are stored separately and do not need to be reconstructed.

Create a concise checkpoint of the user's request and the progress shown above. This checkpoint will be placed before the later messages so the conversation can continue with the necessary context.

## Original Request
[What did the user ask for?]

## Progress So Far
- [Key decisions and work completed in these messages]

## Context Needed to Continue
- [Information from these messages needed to understand the later work]

Only summarize information explicitly present above. Do not infer or recreate later messages.`;

/** Adds the usage of two summary calls (pi imports it from core/usage-totals.ts). */
function combineUsage(a: Usage, b: Usage): Usage {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		totalTokens: a.totalTokens + b.totalTokens,
		cost: {
			input: a.cost.input + b.cost.input,
			output: a.cost.output + b.cost.output,
			cacheRead: a.cost.cacheRead + b.cost.cacheRead,
			cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
			total: a.cost.total + b.cost.total,
		},
	};
}

/**
 * Writes the summary for a prepared compaction. A split turn gets two calls: the history before
 * the turn (or "No prior history.") and the turn's prefix, joined into one summary.
 * `onPayload` sees each request body (edupi's compaction trace event uses it).
 */
export async function compact(
	preparation: CompactionPreparation,
	model: Model,
	apiKey: string | undefined,
	streamFn: StreamFn,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	onPayload?: SimpleStreamOptions["onPayload"],
): Promise<CompactionResult> {
	const { firstKeptEntryId, messagesToSummarize, turnPrefixMessages, isSplitTurn, tokensBefore, previousSummary } =
		preparation;
	const call: SummarizationCall = { model, apiKey, streamFn, signal, thinkingLevel, onPayload };

	let summary: string;
	let summaryUsage: Usage;
	if (isSplitTurn && turnPrefixMessages.length > 0) {
		let historyText = previousSummary ?? "No prior history.";
		let historyUsage: Usage | undefined;
		if (messagesToSummarize.length > 0) {
			const historyResult = await generateSummaryWithUsage(
				messagesToSummarize,
				call,
				customInstructions,
				previousSummary,
			);
			historyText = historyResult.text;
			historyUsage = historyResult.usage;
		}
		const turnPrefixResult = await generateTurnPrefixSummary(turnPrefixMessages, call);
		summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.text}`;
		summaryUsage = historyUsage ? combineUsage(historyUsage, turnPrefixResult.usage) : turnPrefixResult.usage;
	} else {
		const result = await generateSummaryWithUsage(messagesToSummarize, call, customInstructions, previousSummary);
		summary = result.text;
		summaryUsage = result.usage;
	}

	// The files read and changed, appended to the summary.
	const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);
	return { summary, firstKeptEntryId, tokensBefore, usage: summaryUsage, details: { readFiles, modifiedFiles } };
}

/** The summary of a split turn's first part. */
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	call: SummarizationCall,
): Promise<{ text: string; usage: Usage }> {
	const conversationText = serializeConversation(convertToLlm(messages));
	const promptText = `# Conversation\n${conversationText}\n\n# Instructions\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
	return completeSummarization(call, promptText, "Turn prefix summarization");
}
