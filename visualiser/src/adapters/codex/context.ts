// debug/context/get (the exact next Responses request) -> the neutral context snapshot.
// Labelling each input item by where it came from is the core idea of Codex's prompt assembly.
import type { CtxCat } from "../../components/ContextBar";
import type { ContextSnapshot } from "../types";
import type { Json } from "../../view/model";
import { approxTokens, clip } from "../context";

export function codexContext(ctx: Json): ContextSnapshot {
	const input: Json[] = ctx.request.input;
	return {
		items: input.map((item, i) => {
			const parts: Json[] | null = item.type === "message" ? item.content : null;
			return {
				...classify(item, i),
				tokens: approxTokens(item),
				preview: preview(item),
				raw: item,
				summary: `${item.type}${item.role ? `/${item.role}` : ""}${parts && parts.length > 1 ? ` · ${parts.length} parts` : ""}`,
				parts:
					parts &&
					parts.map((p) => ({
						type: p.type,
						text: typeof p.text === "string" ? p.text : undefined,
						tokens: approxTokens(p),
						raw: p,
					})),
			};
		}),
		tools: { names: ctx.request.tools.map((t: Json) => t.name ?? t.type), tokens: approxTokens(ctx.request.tools) },
		contextWindow: ctx.contextWindow,
		autoCompactLimit: ctx.autoCompactLimit,
	};
}

function classify(item: Json, index: number): { label: string; cat: CtxCat } {
	const text = item.content?.[0]?.text ?? "";
	if (item.type === "message") {
		if (index === 0 && item.role === "developer") return { label: "base instructions", cat: "base" };
		if (item.role === "developer") return { label: developerLabel(item), cat: "injected" };
		if (item.role === "user") {
			if (text.startsWith("# AGENTS.md") || text.startsWith("<environment_context>"))
				return { label: "context (AGENTS.md / env)", cat: "injected" };
			if (text.startsWith("<skill>"))
				return { label: `skill ${/<name>(.*?)<\/name>/.exec(text)?.[1] ?? ""} (SKILL.md)`, cat: "injected" };
			if (text.startsWith("Another language model started")) return { label: "compaction summary", cat: "summary" };
			return { label: "user", cat: "user" };
		}
		return { label: "assistant", cat: "assistant" };
	}
	if (item.type === "reasoning") return { label: "reasoning (encrypted)", cat: "reasoning" };
	if (item.type.endsWith("_output")) return { label: "tool output", cat: "output" };
	if (item.type.endsWith("call")) return { label: "tool call", cat: "call" };
	return { label: item.type, cat: "other" };
}

// The developer bundle holds several fragments, one per content part: name them all.
const DEV_PARTS: [string, string][] = [
	["## Memory", "memories"],
	["<skills_instructions>", "skills"],
	["<permissions", "permissions"],
	["<collaboration_mode>", "collaboration mode"],
];
function developerLabel(item: Json): string {
	const names = (item.content ?? []).map(
		(p: Json) => DEV_PARTS.find(([prefix]) => (p.text ?? "").startsWith(prefix))?.[1] ?? "instructions",
	);
	return `developer: ${names.join(" + ")}`;
}

// A short text snippet of an item, for the bar tooltip.
function preview(item: Json): string {
	const raw =
		item.content?.map((p: Json) => p.text ?? "").join(" ") ??
		(item.type.endsWith("call") ? `${item.name ?? ""}(${item.arguments ?? item.input ?? ""})` : null) ??
		(typeof item.output === "string" ? item.output : item.summary?.map((p: Json) => p.text).join(" ")) ??
		"";
	return clip(String(raw));
}
