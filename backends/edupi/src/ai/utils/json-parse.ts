// Mirrors pi packages/ai/src/utils/json-parse.ts (pinned 16f5f0af4): tool-call arguments arrive as
// JSON text in pieces. While streaming, the arguments so far are shown when they parse; at the
// end, text that is not a JSON object becomes an argumentsError that validation reports back.
// Models sometimes put raw control characters or bad escapes inside strings; pi repairs them.
// edupi leaves out pi's partial-JSON parser (the partial-json package).
import type { ToolCall } from "../types.ts";

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);

function isControlCharacter(char: string): boolean {
	const codePoint = char.codePointAt(0);
	return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

function escapeControlCharacter(char: string): string {
	switch (char) {
		case "\b":
			return "\\b";
		case "\f":
			return "\\f";
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default:
			return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
	}
}

/** Inside JSON strings: escapes raw control characters and doubles a backslash before an invalid escape. */
export function repairJson(json: string): string {
	let repaired = "";
	let inString = false;

	for (let index = 0; index < json.length; index++) {
		const char = json[index];

		if (!inString) {
			repaired += char;
			if (char === '"') inString = true;
			continue;
		}

		if (char === '"') {
			repaired += char;
			inString = false;
			continue;
		}

		if (char === "\\") {
			const nextChar = json[index + 1];
			if (nextChar === undefined) {
				repaired += "\\\\";
				continue;
			}
			if (nextChar === "u") {
				const unicodeDigits = json.slice(index + 2, index + 6);
				if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
					repaired += `\\u${unicodeDigits}`;
					index += 5;
					continue;
				}
			}
			if (VALID_JSON_ESCAPES.has(nextChar)) {
				repaired += `\\${nextChar}`;
				index += 1;
				continue;
			}
			repaired += "\\\\";
			continue;
		}

		repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
	}

	return repaired;
}

/** JSON.parse, and on failure once more after repairJson. */
export function parseJsonWithRepair<T>(json: string): T {
	try {
		return JSON.parse(json) as T;
	} catch (error) {
		const repairedJson = repairJson(json);
		if (repairedJson !== json) return JSON.parse(repairedJson) as T;
		throw error;
	}
}

/** The finished arguments text of a tool call. */
export function parseToolCallArguments(json: string | undefined): Pick<ToolCall, "arguments" | "argumentsError"> {
	if (!json?.trim()) return { arguments: {} };
	try {
		const parsed = parseJsonWithRepair<ToolCall["arguments"] | null>(json);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("Tool arguments must be a JSON object");
		}
		return { arguments: parsed };
	} catch (error) {
		return {
			arguments: {},
			argumentsError: `${error instanceof Error ? error.message : String(error)}\n\nReceived arguments:\n${json}`,
		};
	}
}

/** The arguments so far, or the previous value while the text is not yet valid JSON. */
export function parseStreamingJson(partialJson: string, previous: ToolCall["arguments"]): ToolCall["arguments"] {
	try {
		const parsed = parseJsonWithRepair<ToolCall["arguments"] | null>(partialJson);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : previous;
	} catch {
		return previous;
	}
}
