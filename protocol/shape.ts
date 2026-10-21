// Checks a trace event against its fixture in protocol/fixtures/trace/. Used by the edupi and
// visualiser tests; educodex has the same rule in tests/test_trace_fixtures.py.
// Shared vocabulary: protocol/README.md section 6.

export type JsonType = "null" | "array" | "object" | "string" | "number" | "boolean";

export const jsonType = (v: unknown): JsonType =>
	v === null ? "null" : Array.isArray(v) ? "array" : (typeof v as JsonType);

/**
 * Where `actual` does not have the fixture's shape: each fixture key must be there with the
 * same JSON type, and objects are checked key by key. Arrays are checked by type only, and
 * extra keys in `actual` are allowed. Returns paths like "body.messages: expected array, got null".
 */
export function shapeErrors(fixture: unknown, actual: unknown, path = ""): string[] {
	const want = jsonType(fixture),
		got = jsonType(actual);
	if (want !== got) return [`${path || "(root)"}: expected ${want}, got ${got}`];
	if (want !== "object") return [];
	const a = actual as Record<string, unknown>;
	return Object.entries(fixture as Record<string, unknown>).flatMap(([k, v]) =>
		k in a ? shapeErrors(v, a[k], path ? `${path}.${k}` : k) : [`${path ? `${path}.${k}` : k}: missing`],
	);
}
