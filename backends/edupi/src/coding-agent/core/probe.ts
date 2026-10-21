// edupi only (pi has no probe): the hook points the core calls so the teaching extras can watch
// it, as educodex's core/probe.py. The core never imports the observe layer; src/observe/
// implements this interface, and main.ts passes the implementation in. Every hook is optional.
import type { AgentMessage } from "../../agent/types.ts";
import type { ProviderProbe } from "../../ai/types.ts";
import type { CompactionResult } from "./compaction/compaction.ts";

/**
 * All hook points. The provider hooks (model request, stream event, model response) are defined
 * in the ai layer, which cannot import this file; hooks of higher layers are added here.
 */
export interface Probe extends ProviderProbe {
  /** A compaction summary request is about to be sent: its exact body (pi's onPayload sees it). */
  compactionRequest?(request: { reason: string; tokensBefore: number; body: unknown }): void | Promise<void>;
  /** The compaction entry was saved; `messages` is the context rebuilt from it. */
  compacted?(compaction: CompactionResult & { reason: string; messages: AgentMessage[] }): void | Promise<void>;
}
