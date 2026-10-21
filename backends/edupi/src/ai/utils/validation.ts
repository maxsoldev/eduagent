// Mirrors pi packages/ai/src/utils/validation.ts (pinned 16f5f0af4), validateToolArguments: the
// model's arguments are checked against the tool's typebox schema before the tool runs. A failure
// becomes an error tool result, so the model reads what was wrong and can try again.
// edupi leaves out pi's extra coercion for plain JSON schemas and null-to-undefined fixes.
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import type { Tool, ToolCall } from "../types.ts";

type ValidationError = { instancePath: string; keyword: string; message: string; params: unknown };

function formatValidationPath(error: ValidationError): string {
	if (error.keyword === "required") {
		const requiredProperty = (error.params as { requiredProperties?: string[] }).requiredProperties?.[0];
		if (requiredProperty) {
			const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}
	return error.instancePath.replace(/^\//, "").replace(/\//g, ".") || "root";
}

/** Returns the arguments, converted where the schema allows it ("3" -> 3). Throws pi's message if they do not fit. */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): any {
	if (toolCall.argumentsError) {
		throw new Error(`Invalid arguments for tool "${toolCall.name}": ${toolCall.argumentsError}`);
	}
	const args = structuredClone(toolCall.arguments);
	Value.Convert(tool.parameters, args);
	const validator = Compile(tool.parameters);
	if (validator.Check(args)) return args;

	const errors =
		validator
			.Errors(args)
			.map((error) => `  - ${formatValidationPath(error as ValidationError)}: ${error.message}`)
			.join("\n") || "Unknown validation error";
	throw new Error(
		`Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`,
	);
}
