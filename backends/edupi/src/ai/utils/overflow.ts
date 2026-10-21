// Mirrors pi packages/ai/src/utils/overflow.ts (pinned 16f5f0af4): is a failed response a
// context overflow? Providers say so in their error text, each in its own words, so pi matches
// a list of patterns. Some providers accept too much input silently; usage shows it then.
import type { AssistantMessage } from "../types.ts";

/** Error texts of a too-long request (pi's list, for all its providers; OpenRouter passes them on). */
const OVERFLOW_PATTERNS = [
  /prompt (?:is )?too long/i, // Anthropic and z.ai token overflow
  /prompt exceeds max length/i, // z.ai CN endpoint token overflow
  /request_too_large/i, // Anthropic request byte-size overflow (HTTP 413)
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI (Completions & Responses API)
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI-compatible proxies (LiteLLM)
  /input token count.*exceeds the maximum/i, // Google (Gemini)
  /maximum prompt length is \d+/i, // xAI (Grok)
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter (most backends)
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
  /exceeds the limit of \d+/i, // GitHub Copilot
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi For Coding
  /too large for model with \d+ maximum context length/i, // Mistral
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4 server
  /model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
  /prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow error
  /range of input length should be/i, // DashScope / Qwen Token Plan
  /context[_ ]length[_ ]exceeded/i, // Generic fallback
  /too many tokens/i, // Generic fallback
  /token limit exceeded/i, // Generic fallback
  // HTTP 413 means request-size overflow regardless of provider or body text.
  // Match raw SDK errors and formatProviderError's prefix, not a status mentioned in the body.
  /^(?:[\w -]+ API error \(413\):|413(?:\s|:|$))/i,
];

/** Errors that look like overflow but are not (rate limits). */
const NON_OVERFLOW_PATTERNS = [
  /^(Throttling error|Service unavailable):/i, // AWS Bedrock non-overflow errors (human-readable prefixes from formatBedrockError)
  /rate limit/i, // Generic rate limiting
  /too many requests/i, // Generic HTTP 429 style
];

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

/** A length stop below the model's output limit: maybe context pressure, worth one compact and retry. */
export function isRecoverableLength(message: AssistantMessage, desiredMaxOutput: number): boolean {
  return message.stopReason === "length" && desiredMaxOutput > 0 && message.usage.output < desiredMaxOutput;
}
