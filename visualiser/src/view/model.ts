// The neutral view model (ADR 0001). Every adapter maps its backend's native messages into
// ViewActions; reduceView folds them into one View, which the chat, the Inspector and the
// context bar read. Nothing here knows a native protocol. Documented in protocol/README.md.

export type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export type Direction = "in" | "out";

// A backend-only part (for example a Codex plan or file-change diff). Only the components of
// that protocol know `data`'s shape.
export type NativePart = { protocol: string; type: string; data: Json };

export type ToolStatus = "running" | "completed" | "failed" | "declined" | "aborted";
export type Entry =
  | { kind: "user"; id: string; text: string; skills: { name: string; path: string }[] }
  | { kind: "assistant"; id: string; text: string; streaming: boolean; part?: NativePart }
  | { kind: "reasoning"; id: string; summary: string[]; streaming: boolean }
  | { kind: "tool"; id: string; name: string; toolKind: "shell" | "mcp" | "other"; title: string; arguments: Json;
      output: string; status: ToolStatus; exitCode?: number | null; error?: string; streaming: boolean; part?: NativePart }
  | { kind: "compaction"; id: string; streaming: boolean; reason?: string }
  | { kind: "notice"; id: string; level: "info" | "error"; source: "visualiser" | "backend"; text: string }
  | { kind: "native"; id: string; part: NativePart; streaming: boolean };

export type TurnStatus = "running" | "completed" | "interrupted" | "failed";
// id is null for entries outside any backend turn (slash-command notes, errors between turns).
export type Turn = { id: string | null; status: TurnStatus | null; durationMs?: number; entries: Entry[] };

// One native notification or trace event. Trace events use the shared name without a prefix
// ("modelRequest"); native events keep their protocol name ("turn/started", "agent_start").
export type TimelineEvent = { seq: number; ts: number; name: string; trace: boolean; sessionId?: string; data: Json };
export type Approval = { id: string | number; part: NativePart };
export type WireEntry = { direction: Direction; message: Json; at: number };

export type View = {
  status: "connecting" | "open" | "closed";
  closedReason: string | null; // why the connection closed ("educodex exited with code 1")
  sessionId: string | null; // Codex thread id, pi session id
  running: boolean;
  turns: Turn[];
  events: TimelineEvent[];
  wire: WireEntry[]; // native messages, unchanged, for the Protocol tab
  approvals: Approval[];
  paused: { breakpoint: string; info: Json } | null; // step mode (trace "paused")
  pricing: Json | null; // trace "pricing": per-million-token prices
  costs: Json[]; // trace "cost" of every request in this session, in order
  costTotal: Json | null;
  queue: { steering: string[]; followUp: string[] } | null; // messages waiting for the agent (pi's queues); null: none seen
};

export const initialView: View = {
  status: "connecting", closedReason: null, sessionId: null, running: false, turns: [], events: [], wire: [], approvals: [],
  paused: null, pricing: null, costs: [], costTotal: null, queue: null,
};

export type ViewAction =
  | { type: "status"; status: View["status"]; reason?: string }
  | { type: "wire"; direction: Direction; message: Json }
  | { type: "session"; id: string } // a new session: empty chat, keep the timeline, wire and pricing
  | { type: "turnStarted"; id: string }
  | { type: "turnEnded"; id: string; status: TurnStatus; durationMs?: number }
  | { type: "entry"; entry: Entry } // add, or replace the entry with the same id
  | { type: "append"; id: string; field: "text" | "output" | "summary"; delta: string; index?: number }
  | { type: "event"; event: Omit<TimelineEvent, "seq" | "ts"> & { seq?: number; ts?: number } }
  | { type: "approval"; approval: Approval }
  | { type: "approvalResolved"; id: string | number }
  | { type: "notice"; level: "info" | "error"; source: "visualiser" | "backend"; text: string }
  | { type: "queue"; steering: string[]; followUp: string[] }; // the full queues after a change

let localSeq = 1_000_000;
let noticeId = 0;

export function reduceView(view: View, action: ViewAction): View {
  switch (action.type) {
    case "status":
      return { ...view, status: action.status, closedReason: action.status === "closed" ? action.reason ?? "" : view.closedReason };
    case "wire":
      return { ...view, wire: [...view.wire.slice(-1500), { direction: action.direction, message: action.message, at: Date.now() }] };
    case "session":
      return { ...initialView, status: view.status, closedReason: view.closedReason, wire: view.wire, events: view.events, pricing: view.pricing, sessionId: action.id };
    case "turnStarted":
      return { ...view, running: true, turns: [...view.turns, { id: action.id, status: "running", entries: [] }] };
    case "turnEnded":
      return { ...view, running: false, paused: null, approvals: [],
        turns: view.turns.map((t) => (t.id === action.id ? { ...t, status: action.status, durationMs: action.durationMs } : t)) };
    case "entry":
      return { ...view, turns: upsert(view.turns, action.entry) };
    case "append":
      return { ...view, turns: mapEntry(view.turns, action.id, (e) => appendTo(e, action)) };
    case "event":
      return applyEvent(view, { seq: action.event.seq ?? localSeq++, ts: action.event.ts ?? Date.now(), ...action.event });
    case "approval":
      return { ...view, approvals: [...view.approvals, action.approval] };
    case "approvalResolved":
      return { ...view, approvals: view.approvals.filter((a) => a.id !== action.id) };
    case "notice":
      return { ...view, turns: upsert(view.turns, { kind: "notice", id: `notice-${++noticeId}`, level: action.level, source: action.source, text: action.text }) };
    case "queue":
      return { ...view, queue: { steering: action.steering, followUp: action.followUp } };
  }
}

// Shared trace events that change the view, not only the timeline.
function applyEvent(view: View, event: TimelineEvent): View {
  const v = { ...view, events: [...view.events, event] };
  if (!event.trace) return v;
  switch (event.name) {
    case "pricing": return { ...v, pricing: event.data.pricing };
    case "cost": return { ...v, costs: [...v.costs, { ...event.data, seq: event.seq }], costTotal: event.data.total };
    case "paused": return { ...v, paused: { breakpoint: event.data.breakpoint, info: event.data.info } };
    case "resumed": return { ...v, paused: null };
    default: return v;
  }
}

// Replace the entry with the same id, or add it to the open turn (else to a turn of loose entries).
function upsert(turns: Turn[], entry: Entry): Turn[] {
  if (turns.some((t) => t.entries.some((e) => e.id === entry.id))) return mapEntry(turns, entry.id, () => entry);
  const last = turns[turns.length - 1];
  if (last && (last.status === "running" || last.id === null)) return [...turns.slice(0, -1), { ...last, entries: [...last.entries, entry] }];
  return [...turns, { id: null, status: null, entries: [entry] }];
}

function mapEntry(turns: Turn[], id: string, f: (e: Entry) => Entry): Turn[] {
  return turns.map((t) => (t.entries.some((e) => e.id === id) ? { ...t, entries: t.entries.map((e) => (e.id === id ? f(e) : e)) } : t));
}

function appendTo(e: Entry, a: Extract<ViewAction, { type: "append" }>): Entry {
  if (a.field === "text" && e.kind === "assistant") return { ...e, text: e.text + a.delta };
  if (a.field === "output" && e.kind === "tool") return { ...e, output: e.output + a.delta };
  if (a.field === "summary" && e.kind === "reasoning") {
    const summary = [...e.summary];
    summary[a.index ?? 0] = (summary[a.index ?? 0] ?? "") + a.delta;
    return { ...e, summary };
  }
  return e;
}
