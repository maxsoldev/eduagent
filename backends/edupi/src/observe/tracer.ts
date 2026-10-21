// edupi only: the Tracer turns the core's probe calls into trace events, as educodex's
// observe/tracer.py does. pi has no trace events. edupi sends them in pi's type-tagged style,
// {type: "trace", name, ...payload}, on the same stdout as the RPC events. Names and payloads
// are the shared trace vocabulary in protocol/README.md section 6.
import type { AgentMessage } from "../agent/types.ts";
import type { AssistantMessage } from "../ai/types.ts";
import type { CompactionResult } from "../coding-agent/core/compaction/compaction.ts";
import type { Probe } from "../coding-agent/core/probe.ts";

export type TraceOutput = (message: object) => void;

export class Tracer implements Probe {
  private output: TraceOutput | null = null;
  private started = 0; // when the current model request was sent (ms)

  /** RPC mode calls this once it owns stdout. Events before that are dropped. */
  connect(output: TraceOutput) {
    this.output = output;
  }

  private emit(name: string, payload: object) {
    this.output?.({ type: "trace", name, ...payload });
  }

  modelRequest(request: { api: string; url: string; body: unknown }) {
    this.started = performance.now();
    this.emit("modelRequest", request);
  }

  streamEvent(event: unknown) {
    this.emit("streamEvent", { event });
  }

  modelResponse(message: AssistantMessage) {
    const { stopReason, errorMessage, responseId, content, usage } = message;
    const seconds = Math.round(performance.now() - this.started) / 1000;
    this.emit("modelResponse", { stopReason, errorMessage, responseId, content, usage, seconds });
  }

  compactionRequest(request: { reason: string; tokensBefore: number; body: unknown }) {
    this.emit("compactionRequest", request);
  }

  /** tokensAfter is pi's estimate of the rebuilt context (estimatedTokensAfter). */
  compacted(compaction: CompactionResult & { reason: string; messages: AgentMessage[] }) {
    const { reason, summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter, details, messages } = compaction;
    this.emit("compacted", { reason, summary, firstKeptEntryId, tokensBefore, tokensAfter: estimatedTokensAfter, details, messages });
  }
}
