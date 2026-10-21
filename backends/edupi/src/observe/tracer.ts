// edupi only: the Tracer turns the core's probe calls into trace events, as educodex's
// observe/tracer.py does. pi has no trace events. edupi sends them in pi's type-tagged style,
// {type: "trace", name, ...payload}, on the same stdout as the RPC events. Names and payloads
// are the shared trace vocabulary in protocol/README.md section 6.
import type { AgentToolCall, AgentToolResult } from "../agent/types.ts";
import type { AssistantMessage } from "../ai/types.ts";
import type { Probe, PromptAssembledInfo, SkillsLoadedInfo } from "../coding-agent/core/probe.ts";

/** Where each prompt section comes from (pi's file, or the files the user wrote). */
function sectionSource(name: string, info: PromptAssembledInfo): string {
  switch (name) {
    case "preamble": return info.customPromptFiles.systemPrompt ?? "system-prompt.ts";
    case "tools": return "system-prompt.ts + tool snippets";
    case "rules": return "system-prompt.ts + tool guidelines";
    case "addendum": return info.customPromptFiles.appendSystemPrompt ?? "APPEND_SYSTEM.md";
    case "project_context": return info.contextFiles.join(", ");
    case "skills": return "skills.ts formatSkillsForPrompt";
    case "cwd": return "process cwd";
    default: return name;
  }
}

const approxTokens = (text: string) => Math.ceil(text.length / 4);

export type TraceOutput = (message: object) => void;

export class Tracer implements Probe {
  private output: TraceOutput | null = null;
  private started = 0; // when the current model request was sent (ms)
  private registeredTools = new Map<string | undefined, string>(); // the last tool specs sent, per session (JSON)

  /** RPC mode calls this once it owns stdout. Events before that are dropped. */
  connect(output: TraceOutput) {
    this.output = output;
  }

  private emit(name: string, payload: object) {
    this.output?.({ type: "trace", name, ...payload });
  }

  /** Before the request: the tool specs the model gets, when they are new for this session (educodex's toolsRegistered). */
  modelRequest(request: { api: string; url: string; body: unknown }, sessionId?: string) {
    const tools = (request.body as { tools?: unknown[] }).tools ?? [];
    if (JSON.stringify(tools) !== this.registeredTools.get(sessionId)) {
      this.registeredTools.set(sessionId, JSON.stringify(tools));
      this.emit("toolsRegistered", { tools });
    }
    this.started = performance.now();
    this.emit("modelRequest", request);
  }

  streamEvent(event: unknown) {
    this.emit("streamEvent", { event });
  }

  toolDispatch({ toolCall, parallel }: { toolCall: AgentToolCall; parallel: boolean }) {
    this.emit("toolDispatch", { tool: toolCall.name, callId: toolCall.id, arguments: toolCall.arguments, parallel });
  }

  /** output is the text the model reads; tokens a rough count (4 bytes per token), as in educodex. */
  toolOutput({ toolCall, result, isError, durationMs }: { toolCall: AgentToolCall; result: AgentToolResult<unknown>; isError: boolean; durationMs?: number }) {
    const output = result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    const tokens = Math.floor((Buffer.byteLength(output, "utf-8") + 3) / 4);
    this.emit("toolOutput", { tool: toolCall.name, callId: toolCall.id, output, isError, durationMs, tokens });
  }

  /** One fragment per prompt section, as educodex's promptAssembled; changed = in this run's system message patch. */
  promptAssembled(info: PromptAssembledInfo) {
    const patch = info.patch ?? {};
    const fragments = Object.entries(info.sections).map(([kind, text]) => ({
      kind, role: "system", source: sectionSource(kind, info), text, tokens: approxTokens(text), changed: kind in patch,
    }));
    const removed = Object.keys(patch).filter((name) => patch[name] === null);
    this.emit("promptAssembled", { fragments, removed, firstTurn: info.firstTurn });
  }

  skillsLoaded(info: SkillsLoadedInfo) {
    this.emit("skillsLoaded", {
      roots: info.roots,
      skills: info.skills.map((s) => ({ name: s.name, description: s.description, path: s.filePath, scope: s.sourceInfo.scope, disableModelInvocation: s.disableModelInvocation })),
      errors: info.diagnostics.map((d) => ({ path: d.path, message: d.message })),
      projectTrusted: info.projectTrusted,
    });
  }

  modelResponse(message: AssistantMessage) {
    const { stopReason, errorMessage, responseId, content, usage } = message;
    const seconds = Math.round(performance.now() - this.started) / 1000;
    this.emit("modelResponse", { stopReason, errorMessage, responseId, content, usage, seconds });
  }
}
