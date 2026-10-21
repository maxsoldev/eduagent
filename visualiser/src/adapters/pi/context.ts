// edupi's debug_get_context (the exact next Chat Completions request) -> the neutral context snapshot of the Context tab.
// pi's prompt is one system message built from named sections (packages/coding-agent/src/core/
// system-prompt.ts); edupi's promptAssembled trace event names them, so the first item shows
// one part per section: preamble, tools, rules, project_context (AGENTS.md), skills, cwd.
import type { CtxCat } from "../../components/ContextBar";
import type { ContextItem, ContextSnapshot } from "../types";
import type { Json } from "../../view/model";

const approxTokens = (v: Json) => Math.ceil((typeof v === "string" ? v.length : JSON.stringify(v).length) / 4);

const textOf = (content: Json): string =>
  typeof content === "string" ? content : (content ?? []).map((c: Json) => c.text ?? `[${c.type}]`).join(" ");

const clip = (t: string) => { const flat = t.replace(/\s+/g, " ").trim(); return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat; };

/**
 * body: the request's messages and tools (edupi's debug_get_context). fragments: promptAssembled's
 * sections, used as the system message's parts when they make up its text. autoCompactLimit: pi
 * compacts above it (the context window minus pi's reserveTokens).
 */
export function piContext(body: Json, fragments: Json[] | null, contextWindow: number, autoCompactLimit: number): ContextSnapshot {
  const messages: Json[] = body.messages ?? [];
  // The path each tool call read, so a tool output that is a SKILL.md can be named.
  const readPaths: Record<string, string> = {};
  for (const m of messages) for (const c of m.tool_calls ?? []) {
    if (c.function?.name === "read") try { readPaths[c.id] = JSON.parse(c.function.arguments).path ?? ""; } catch { /* partial arguments */ }
  }
  const items: ContextItem[] = messages.map((m, i) => {
    const text = textOf(m.content);
    const base = { tokens: approxTokens(m), preview: clip(text || (m.tool_calls ?? []).map((c: Json) => `${c.function?.name}(${c.function?.arguments})`).join(" ")), raw: m, parts: null };
    const { label, cat } = classify(m, i, text, readPaths);
    const summary = `${m.role}${m.tool_calls ? ` · ${m.tool_calls.length} tool call${m.tool_calls.length > 1 ? "s" : ""}` : ""}`;
    if (i === 0 && fragments && fragments.map((f) => f.text).join("\n\n") === text) {
      return { ...base, label, cat, summary: `${summary} · ${fragments.length} sections`,
        parts: fragments.map((f) => ({ type: f.kind, text: f.text, tokens: f.tokens, raw: f })) };
    }
    return { ...base, label, cat, summary };
  });
  const tools: Json[] = body.tools ?? [];
  return {
    items,
    tools: { names: tools.map((t) => t.function?.name ?? t.type), tokens: tools.length ? approxTokens(tools) : 0 },
    contextWindow, autoCompactLimit,
  };
}

function classify(m: Json, index: number, text: string, readPaths: Record<string, string>): { label: string; cat: CtxCat } {
  switch (m.role) {
    case "system": case "developer": return index === 0 ? { label: "system prompt", cat: "base" } : { label: "system update", cat: "injected" };
    case "user":
      if (text.startsWith("<skill name=")) return { label: `skill ${/<skill name="(.*?)"/.exec(text)?.[1] ?? ""} (/skill:)`, cat: "injected" };
      if (text.startsWith("The conversation history before this point was compacted")) return { label: "compaction summary", cat: "summary" };
      return { label: "user", cat: "user" };
    case "assistant": return m.tool_calls?.length && !text ? { label: "tool call", cat: "call" } : { label: "assistant", cat: "assistant" };
    case "tool": return { label: readPaths[m.tool_call_id]?.endsWith("SKILL.md") ? "tool output: SKILL.md" : "tool output", cat: "output" };
    default: return { label: m.role ?? "other", cat: "other" };
  }
}
