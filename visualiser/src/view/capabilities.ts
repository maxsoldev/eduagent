// Capabilities come only from the launcher config entry (GET /backends). A panel or control
// for a feature is shown only if the backend lists that feature.
//   approvals: approval policy select, approval cards, Guardrails tab (with trace)
//   sandbox: sandbox select, Guardrails tab (with trace)
//   memories: /memory-* commands     skills: /skills and the $ popup
//   compaction: compact button and /compact     stepMode: step mode toggle
//   trace: Requests and Tools tabs, cost badge     contextInspector: Context tab
//   mcp: MCP servers in the Tools tab     queues: steer and follow-up while a turn runs (pi)
export type Capability = "approvals" | "sandbox" | "memories" | "skills" | "compaction" | "mcp" | "trace" | "stepMode" | "contextInspector" | "queues";
export type Capabilities = ReadonlySet<string>;
