// Mirrors pi packages/ai/src/utils/sanitize-unicode.ts (pinned 16f5f0af4). An unpaired UTF-16
// surrogate (half an emoji, e.g. from cut text) is not valid Unicode: many providers refuse the
// JSON. Emoji are pairs and stay.

/** Removes unpaired high (D800-DBFF) and low (DC00-DFFF) surrogates. */
export function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}
