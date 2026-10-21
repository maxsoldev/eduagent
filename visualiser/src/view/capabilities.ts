// Capabilities come only from the launcher config entry (GET /backends; names in launcher/src/api.ts).
// FEATURES says which capabilities each panel or control needs; App, Inspector and the adapters ask it.
import type { Capability } from "@eduagent/launcher/api";

export type { Capability };
export type Capabilities = ReadonlySet<Capability>;

const has = (c: Capability) => (caps: Capabilities) => caps.has(c);

export const FEATURES = {
	approvals: has("approvals"), // approval policy select, approval cards
	sandbox: has("sandbox"), // sandbox select
	skills: has("skills"), // /skills and the $ popup
	compact: has("compaction"), // compact button
	stepMode: has("stepMode"), // step mode toggle
	costBadge: has("trace"),
	queues: has("queues"), // steer, follow-up and abort while a turn runs (pi)
	contextTab: has("contextInspector"),
	requestsTab: has("trace"),
	toolsTab: has("trace"),
	mcpServers: has("mcp"), // MCP servers in the Tools tab
	guardrailsTab: (caps: Capabilities) => caps.has("trace") && (caps.has("approvals") || caps.has("sandbox")),
} satisfies Record<string, (caps: Capabilities) => boolean>;
export type Feature = keyof typeof FEATURES;

/** Is this feature shown for a backend with these capabilities? */
export const shows = (caps: Capabilities, feature: Feature) => FEATURES[feature](caps);
