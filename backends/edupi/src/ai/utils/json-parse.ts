// Mirrors pi packages/ai/src/utils/json-parse.ts (pinned 16f5f0af4): tool-call arguments arrive as
// JSON text in pieces. While streaming, the arguments so far are shown when they parse; at the
// end, text that is not a JSON object becomes an argumentsError that validation reports back.
// edupi leaves out pi's partial-JSON parser and its repair of bad string escapes.
import type { ToolCall } from "../types.ts";

/** The finished arguments text of a tool call. */
export function parseToolCallArguments(json: string | undefined): Pick<ToolCall, "arguments" | "argumentsError"> {
  if (!json?.trim()) return { arguments: {} };
  try {
    const parsed = JSON.parse(json);
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
    const parsed = JSON.parse(partialJson);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : previous;
  } catch {
    return previous;
  }
}
