"""Clean up MCP tool input schemas so the Responses API accepts them.

Mirrors codex-rs/tools/src/json_schema.rs (simplified). MCP servers can send any JSON Schema;
the model API is stricter. Rules:
  * boolean schemas (`true`/`false`) become {"type": "string"}
  * `const: x` becomes `enum: [x]`
  * a missing `type` is inferred (properties -> object, items -> array, enum -> string, numeric bounds -> number);
    if nothing hints at a type the schema stays untyped
  * objects always get `properties`
"""

from typing import Any

NUMERIC_KEYS = ("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf")


def sanitize_schema(schema: Any) -> dict[str, Any]:
    if isinstance(schema, bool) or not isinstance(schema, dict):
        return {"type": "string"}
    out = dict(schema)
    if "const" in out:
        out["enum"] = [out.pop("const")]
    if "type" not in out and not any(k in out for k in ("anyOf", "oneOf", "allOf", "$ref")):
        if "properties" in out or "additionalProperties" in out:
            out["type"] = "object"
        elif "items" in out:
            out["type"] = "array"
        elif "enum" in out:
            out["type"] = "string"
        elif any(k in out for k in NUMERIC_KEYS):
            out["type"] = "number"
        # otherwise leave it untyped ({} accepts anything), as Codex does
    if out.get("type") == "object":
        out["properties"] = {k: sanitize_schema(v) for k, v in out.get("properties", {}).items()}
        if isinstance(out.get("additionalProperties"), dict):
            out["additionalProperties"] = sanitize_schema(out["additionalProperties"])
    if out.get("type") == "array" and "items" in out:
        out["items"] = sanitize_schema(out["items"])
    for key in ("anyOf", "oneOf", "allOf"):
        if key in out:
            out[key] = [sanitize_schema(s) for s in out[key]]
    if "$defs" in out:
        out["$defs"] = {k: sanitize_schema(v) for k, v in out["$defs"].items()}
    return out
