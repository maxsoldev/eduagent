// edupi only (pi has no probe): the hook points the core calls so the teaching extras can watch
// it, as educodex's core/probe.py. The core never imports the observe layer; src/observe/
// implements this interface, and main.ts passes the implementation in. Every hook is optional.
import type { AgentMessage, AgentProbe } from "../../agent/types.ts";
import type { CompactionResult } from "./compaction/compaction.ts";

/**
 * All hook points. The lower layers cannot import this file, so their hooks are defined there:
 * the provider hooks (model request, stream event, model response) in ai/types.ts, the agent
 * loop hooks (tool dispatch, tool output) in agent/types.ts. Coding-agent hooks are added here.
 */
export interface Probe extends AgentProbe {
  /** A compaction summary request is about to be sent: its exact body (pi's onPayload sees it). */
  compactionRequest?(request: { reason: string; tokensBefore: number; body: unknown }): void | Promise<void>;
  /** The compaction entry was saved; `messages` is the context rebuilt from it. */
  compacted?(compaction: CompactionResult & { reason: string; messages: AgentMessage[] }): void | Promise<void>;
}
