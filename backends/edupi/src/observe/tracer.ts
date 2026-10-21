// edupi only: the Tracer turns the core's probe calls into trace events, as educodex's
// observe/tracer.py does. pi has no trace events. edupi sends them in pi's type-tagged style,
// {type: "trace", name, ...payload}, on the same stdout as the RPC events. Names and payloads
// are the shared trace vocabulary in protocol/README.md section 6.
import type { AssistantMessage } from "../ai/types.ts";
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
    const { api, stopReason, errorMessage, responseId, content, usage } = message;
    const seconds = Math.round(performance.now() - this.started) / 1000;
    this.emit("modelResponse", { api, stopReason, errorMessage, responseId, content, usage, seconds });
  }
}
