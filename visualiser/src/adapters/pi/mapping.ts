// pi RPC protocol -> neutral view model. This file and the other files in adapters/pi/ are the
// only places that know pi's message shapes. pi writes one JSON object per line: replies
// ({type: "response", command, id}) and events (every other type).
// Event types: packages/coding-agent/src/core/agent-session.ts (AgentSessionEvent) and
// packages/agent/src/types.ts (AgentEvent) at the pinned commit.
import type { Entry, Json, ToolStatus, ViewAction } from "../../view/model";

export const PROTOCOL = "pi-rpc";

const text = (content: Json): string =>
  typeof content === "string" ? content : (content ?? []).filter((c: Json) => c.type === "text").map((c: Json) => c.text).join("\n");

/**
 * Makes a mapping from one incoming pi message to view actions. pi events carry no session,
 * turn or message ids, so the mapping keeps a little state: the current session id (from the
 * get_state reply), the open turn and the message being streamed.
 */
export function createPiMapping(): (message: Json) => ViewAction[] {
  let sessionId: string | undefined;
  let turn = 0, message = 0, compaction = 0;
  let turnId: string | undefined;
  let first: number | undefined, last = 0; // the open turn's first and last message times (ms)
  const tools: Record<string, Json> = {}; // arguments by tool call id (only the start event is sure to have them)
  let batch: Extract<Entry, { kind: "tool" }>[] = []; // the tool calls of the last assistant message
  const msgId = () => `${sessionId ?? "pi"}-m${message}`;

  return (m: Json) => {
    if (m.type === "response") return response(m);
    if (m.type === "trace") { // edupi's teaching extras: {type: "trace", name, ...payload} (protocol/README.md section 6)
      const { type: _, name, ...data } = m;
      return [{ type: "event", event: { name, trace: true, sessionId, data } }];
    }
    const { type, ...data } = m;
    const out: ViewAction[] = [{ type: "event", event: { name: type, trace: false, sessionId, data } }];
    switch (type) {
      case "agent_start":
        if (!turnId) out.push({ type: "turnStarted", id: (turnId = `${sessionId ?? "pi"}-t${++turn}`) });
        break;
      case "agent_settled":
        // pi ends the tools it aborts with an error result; here they count as aborted.
        if (m.aborted) for (const t of batch) if (t.status === "failed") out.push({ type: "entry", entry: { ...t, status: "aborted" } });
        if (turnId) out.push({ type: "turnEnded", id: turnId, status: m.aborted ? "interrupted" : "completed",
          durationMs: first !== undefined ? last - first : undefined });
        turnId = first = undefined, last = 0;
        break;
      case "message_start":
        message++;
        out.push(...messageEntries(m.message, true));
        break;
      case "message_update": {
        const e = m.assistantMessageEvent;
        const id = `${msgId()}-c${e.contentIndex}`;
        if (e.type === "text_start") out.push({ type: "entry", entry: { kind: "assistant", id, text: "", streaming: true } });
        if (e.type === "text_delta") out.push({ type: "append", id, field: "text", delta: e.delta });
        if (e.type === "thinking_start") out.push({ type: "entry", entry: { kind: "reasoning", id, summary: [""], streaming: true } });
        if (e.type === "thinking_delta") out.push({ type: "append", id, field: "summary", delta: e.delta, index: 0 });
        break;
      }
      case "message_end": // a reply's timestamp is when it started, so add its durationMs; a tool result is made when the tool ends
        first ??= m.message.timestamp;
        last = Math.max(last, m.message.timestamp + (m.message.role === "assistant" ? m.message.durationMs ?? 0 : 0));
        out.push(...messageEntries(m.message, false));
        break;
      case "tool_execution_start":
        out.push(toolEntry(m, "", "running"));
        break;
      case "tool_execution_update": // partialResult holds all output so far
        out.push(toolEntry(m, text(m.partialResult?.content), "running"));
        break;
      case "tool_execution_end":
        out.push(toolEntry(m, text(m.result?.content), m.isError ? "failed" : "completed"));
        break;
      case "queue_update": // the full steering and follow-up queues, as texts
        out.push({ type: "queue", steering: m.steering, followUp: m.followUp });
        break;
      case "compaction_start": // reason: manual, threshold or overflow
        out.push({ type: "entry", entry: { kind: "compaction", id: `${sessionId ?? "pi"}-k${++compaction}`, streaming: true, reason: m.reason } });
        break;
      case "compaction_end": { // no result: it failed or was cancelled, so the entry becomes pi's message
        const id = `${sessionId ?? "pi"}-k${compaction}`;
        out.push({ type: "entry", entry: m.result ? { kind: "compaction", id, streaming: false, reason: m.reason }
          : { kind: "notice", id, level: m.errorMessage ? "error" : "info", source: "backend", text: m.errorMessage ?? "Compaction cancelled" } });
        break;
      }
    }
    return out;
  };

  // pi's tools: bash is a shell tool; read, edit and write work on one path. A finished edit
  // carries its diff in result.details (for the user, not the model): it becomes a pi part.
  function toolEntry(m: Json, output: string, status: ToolStatus): ViewAction {
    const args = (tools[m.toolCallId] ??= m.args ?? {});
    const diff = m.toolName === "edit" ? m.result?.details?.diff : undefined;
    const entry: Entry = { kind: "tool", id: m.toolCallId, name: m.toolName, toolKind: m.toolName === "bash" ? "shell" : "other",
      title: args.command ?? args.path ?? m.toolName, arguments: args, output, status, streaming: status === "running",
      exitCode: m.result?.structuredContent?.exit_code,
      ...(typeof diff === "string" ? { part: { protocol: PROTOCOL, type: "editDiff", data: { path: args.path, diff, firstChangedLine: m.result.details.firstChangedLine } } } : {}) };
    batch = [...batch.filter((t) => t.id !== entry.id), entry];
    return { type: "entry", entry };
  }

  // Replies to our own commands. get_state tells which session this process holds;
  // get_messages gives the conversation so far (a session that was already in progress); it
  // fills only an empty chat, so a later get_messages does not repeat the turns.
  function response(m: Json): ViewAction[] {
    if (m.command === "get_state" && m.success && m.data.sessionId !== sessionId)
      return [{ type: "session", id: (sessionId = m.data.sessionId) }];
    if (m.command === "get_messages" && m.success && turn === 0) return history(m.data.messages);
    return [];
  }

  // Past messages as finished turns: each user message starts one. A tool call and its result
  // (a later toolResult message) become one tool entry.
  function history(messages: Json[]): ViewAction[] {
    const out: ViewAction[] = [];
    const results = new Map(messages.filter((x) => x.role === "toolResult").map((x) => [x.toolCallId, x]));
    let open: string | undefined;
    const close = () => { if (open) out.push({ type: "turnEnded", id: open, status: "completed" }); open = undefined; };
    for (const msg of messages) {
      if (msg.role === "user") { close(); out.push({ type: "turnStarted", id: (open = `${sessionId ?? "pi"}-t${++turn}`) }); }
      message++;
      out.push(...messageEntries(msg, false));
      if (msg.role !== "assistant") continue;
      for (const c of msg.content as Json[]) {
        if (c.type !== "toolCall") continue;
        const result = results.get(c.id);
        out.push(toolEntry({ toolCallId: c.id, toolName: c.name, args: c.arguments, result }, text(result?.content),
          !result ? "aborted" : result.isError ? "failed" : "completed"));
      }
    }
    close();
    return out;
  }

  // User messages become one entry; an assistant message one entry per text block.
  function messageEntries(msg: Json, streaming: boolean): ViewAction[] {
    if (msg.role === "user") return [{ type: "entry", entry: { kind: "user", id: msgId(), text: text(msg.content), skills: [] } }];
    if (msg.role !== "assistant") return [];
    const content = msg.content as Json[];
    if (!streaming && content.some((c) => c.type === "toolCall")) batch = [];
    const entries = content.flatMap((c, i): ViewAction[] => {
      const id = `${msgId()}-c${i}`;
      const entry: Entry | null = c.type === "text" ? { kind: "assistant", id, text: c.text, streaming }
        : c.type === "thinking" ? { kind: "reasoning", id, summary: [c.thinking], streaming } : null;
      return entry ? [{ type: "entry", entry }] : [];
    });
    if (!streaming && msg.stopReason === "error")
      entries.push({ type: "notice", level: "error", source: "backend", text: msg.errorMessage ?? "error" });
    return entries;
  }
}
