// Mirrors pi packages/ai/src/utils/overflow.ts (pinned 16f5f0af4): is a failed response a
// context overflow? Providers say so in their error text, each in its own words, so pi matches
// a list of patterns. Some providers accept too much input silently; usage shows it then.
import type { AssistantMessage } from "../types.ts";

/**
 * Error texts of a too-long request: a few of pi's patterns, for the model families behind
 * OpenRouter (OpenRouter passes the upstream text on), plus pi's generic fallbacks.
 */
const OVERFLOW_PATTERNS = [
	/prompt (?:is )?too long/i, // Anthropic
	/exceeds the context window/i, // OpenAI (Completions & Responses API)
	/input token count.*exceeds the maximum/i, // Google (Gemini)
	/maximum context length is \d+ tokens/i, // OpenRouter (most backends)
	/context[_ ]length[_ ]exceeded/i, // Generic fallback
	/too many tokens/i, // Generic fallback
	/token limit exceeded/i, // Generic fallback
	/^413\b/, // HTTP 413 (the OpenAI SDK's message starts with the status): request-size overflow
];

/** Errors that look like overflow but are not (rate limits). */
const NON_OVERFLOW_PATTERNS = [/rate limit/i, /too many requests/i];

/**
 * True if the message is a context overflow: an error with an overflow text, or a "successful"
 * response whose input was bigger than the context window (silent overflow), or a length stop
 * with no output because the input filled the window.
 */
export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
	if (message.stopReason === "error" && message.errorMessage) {
		const isNonOverflow = NON_OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!));
		if (!isNonOverflow && OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!))) return true;
	}
	if (contextWindow && message.stopReason === "stop") {
		if (message.usage.input + message.usage.cacheRead > contextWindow) return true;
	}
	if (contextWindow && message.stopReason === "length" && message.usage.output === 0) {
		if (message.usage.input + message.usage.cacheRead >= contextWindow * 0.99) return true;
	}
	return false;
}
