// What the timeline shows for one event: a title, a category, a short explanation and links.
// Each adapter has its own table (adapters/<protocol>/explain.ts).
import type { TimelineEvent } from "./model";

export type Category = "prompt" | "model" | "loop" | "tools" | "guardrails" | "mcp" | "memory" | "protocol" | "debug";
// chapter: the backend's guide chapter. source: a path in the harness's source tree.
export type Info = { title: string; category: Category; text: string; chapter?: string; source?: string };

export type Explainer = {
	info: (e: Pick<TimelineEvent, "name" | "trace">) => Info;
	summary: (e: TimelineEvent) => string;
	noisy: (e: TimelineEvent) => boolean; // streaming deltas, hidden by default
};

export const CATEGORY_COLORS: Record<Category, string> = {
	prompt: "#7dd3fc",
	model: "#fbbf24",
	loop: "#e5e7eb",
	tools: "#c084fc",
	guardrails: "#f87171",
	mcp: "#34d399",
	memory: "#94a3b8",
	protocol: "#64748b",
	debug: "#fb923c",
};
