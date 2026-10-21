// Mirrors pi packages/ai/src/utils/error-body.ts (pinned 16f5f0af4): the error text of a failed
// provider request. The OpenAI SDK's message is "<status> <error.message>", but the parsed error
// body (the SDK's `error` field) can say more, so pi shows "<status>: <body>" when the message
// lacks the body. edupi keeps only the OpenAI SDK's field shapes (pi also reads Mistral, Google, Bedrock).

export const MAX_PROVIDER_ERROR_BODY_CHARS = 4000;

export interface NormalizedProviderError {
	status?: number;
	body?: string;
	message: string;
	messageCarriesBody: boolean; // the message already contains the body
}

export function normalizeProviderError(error: unknown): NormalizedProviderError {
	if (!(error instanceof Error)) return { message: safeJsonStringify(error), messageCarriesBody: false };
	const sdkError = error as Error & { status?: unknown; error?: unknown };
	const status = typeof sdkError.status === "number" ? sdkError.status : undefined;
	const body = extractBody(sdkError.error);
	return {
		status,
		body,
		message: error.message,
		messageCarriesBody: body === undefined || error.message.includes(body),
	};
}

/** Only a plain, non-empty object counts as a parsed body. */
function extractBody(parsed: unknown): string | undefined {
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const proto = Object.getPrototypeOf(parsed);
	if ((proto !== Object.prototype && proto !== null) || Object.keys(parsed).length === 0) return undefined;
	const trimmed = safeJsonStringify(parsed).trim();
	return trimmed.length > 0 ? truncateErrorText(trimmed, MAX_PROVIDER_ERROR_BODY_CHARS) : undefined;
}

export function formatProviderError(norm: NormalizedProviderError): string {
	if (norm.messageCarriesBody || norm.status === undefined || norm.body === undefined) return norm.message;
	return `${norm.status}: ${norm.body}`;
}

export function truncateErrorText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

export function safeJsonStringify(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}
