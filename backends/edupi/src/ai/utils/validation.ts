// Mirrors pi packages/ai/src/utils/validation.ts (pinned 16f5f0af4), validateToolArguments: the
// model's arguments are checked against the tool's typebox schema before the tool runs. A failure
// becomes an error tool result, so the model reads what was wrong and can try again.
// edupi leaves out pi's extra coercion for plain JSON schemas (edupi's tools all use typebox) and
// pi's compiled-validator cache.
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import type { Tool, ToolCall } from "../types.ts";

interface JsonSchemaObject {
	properties?: Record<string, JsonSchemaObject>;
	required?: string[];
	items?: JsonSchemaObject | JsonSchemaObject[];
}

/**
 * Models often send null for an optional argument they mean to leave out. pi deletes such a
 * null when the property's schema does not allow null, so `Value.Convert` cannot turn it into 0 or "".
 */
function normalizeOptionalNulls(value: unknown, schema: JsonSchemaObject): void {
	if (Array.isArray(value)) {
		if (Array.isArray(schema.items)) {
			for (let index = 0; index < value.length; index++) {
				const itemSchema = schema.items[index];
				if (itemSchema) normalizeOptionalNulls(value[index], itemSchema);
			}
		} else if (schema.items) {
			for (const item of value) normalizeOptionalNulls(item, schema.items);
		}
		return;
	}
	if (typeof value !== "object" || value === null || !schema.properties) return;

	const object = value as Record<string, unknown>;
	const required = new Set(schema.required ?? []);
	for (const [key, propertySchema] of Object.entries(schema.properties)) {
		if (!(key in object)) continue;
		if (
			object[key] === null &&
			!required.has(key) &&
			typeof (propertySchema as { $ref?: unknown }).$ref !== "string" &&
			getSubSchemaValidator(propertySchema)?.Check(null) === false
		) {
			delete object[key];
		} else {
			normalizeOptionalNulls(object[key], propertySchema);
		}
	}
}

function getSubSchemaValidator(schema: JsonSchemaObject): ReturnType<typeof Compile> | undefined {
	try {
		return Compile(schema as Tool["parameters"]);
	} catch {
		return undefined;
	}
}

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
	normalizeOptionalNulls(args, tool.parameters as JsonSchemaObject);
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
