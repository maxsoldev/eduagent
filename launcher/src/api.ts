// The launcher's HTTP API types: GET /backends and the capability names. No Node imports, so
// the visualiser imports this file too (visualiser/src/launcher.ts).

/** Features a backend may list; the visualiser shows a panel only for the ones listed (view/capabilities.ts). */
export const CAPABILITIES = ["approvals", "sandbox", "memories", "skills", "compaction", "mcp", "trace", "stepMode", "contextInspector", "queues"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** One backend as GET /backends lists it. */
export type BackendInfo = {
  name: string; // also the WebSocket path: /backends/<name>
  harness: string; // the harness it re-implements, e.g. "Codex"
  protocol: string; // the native protocol it speaks; the visualiser picks its adapter by this
  description?: string;
  capabilities: Capability[];
};

export type BackendList = { cwd: string; backends: BackendInfo[] };
