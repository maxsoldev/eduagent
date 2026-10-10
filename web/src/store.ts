// All UI state is derived from the notifications the app server sends.
import type { Json, WireMessage, Direction } from "./rpc";

export type TraceEvent = { seq: number; ts: number; method: string; params: Json };
export type ChatEntry =
  | { kind: "item"; item: Json }
  | { kind: "plan"; plan: { step: string; status: string }[]; explanation?: string }
  | { kind: "turn"; turn: Json }
  | { kind: "error"; message: string };
export type Approval = { id: string | number; method: string; params: Json };

export type State = {
  status: "connecting" | "open" | "closed";
  threadId: string | null;
  thread: Json | null;
  turnRunning: boolean;
  currentTurnId: string | null;
  chat: ChatEntry[];
  live: Record<string, Json>; // in-progress items by id (streaming text, command output)
  events: TraceEvent[];
  wire: { direction: Direction; message: WireMessage; at: number }[];
  approvals: Approval[];
  paused: Json | null;
  tokenUsage: Json | null;
};

export const initialState: State = {
  status: "connecting", threadId: null, thread: null, turnRunning: false, currentTurnId: null,
  chat: [], live: {}, events: [], wire: [], approvals: [], paused: null, tokenUsage: null,
};

export type Action =
  | { type: "status"; status: State["status"] }
  | { type: "thread"; thread: Json }
  | { type: "notification"; method: string; params: Json }
  | { type: "serverRequest"; approval: Approval }
  | { type: "approvalAnswered"; id: string | number }
  | { type: "wire"; direction: Direction; message: WireMessage }
  | { type: "reset" };

let localSeq = 1_000_000;

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "status":
      return { ...state, status: action.status };
    case "thread":
      return { ...initialState, status: state.status, wire: state.wire, threadId: action.thread.id, thread: action.thread, events: state.events };
    case "reset":
      return { ...initialState, status: state.status };
    case "wire":
      return { ...state, wire: [...state.wire.slice(-1500), { direction: action.direction, message: action.message, at: Date.now() }] };
    case "serverRequest":
      return { ...state, approvals: [...state.approvals, action.approval] };
    case "approvalAnswered":
      return { ...state, approvals: state.approvals.filter((a) => a.id !== action.id) };
    case "notification":
      return applyNotification(state, action.method, action.params);
  }
}

function applyNotification(state: State, method: string, params: Json): State {
  const { _seq, _ts, ...rest } = params ?? {};
  const event: TraceEvent = { seq: _seq ?? localSeq++, ts: (_ts ?? Date.now() / 1000) * 1000, method, params: rest };
  const s: State = { ...state, events: [...state.events, event] };
  switch (method) {
    case "turn/started":
      return { ...s, turnRunning: true, currentTurnId: rest.turn.id };
    case "turn/completed":
      return { ...s, turnRunning: false, paused: null, approvals: [], chat: [...s.chat, { kind: "turn", turn: rest.turn }] };
    case "serverRequest/resolved": // answered or abandoned (e.g. interrupted): drop the card
      return { ...s, approvals: s.approvals.filter((a) => a.id !== rest.requestId) };
    case "item/started":
      return { ...s, live: { ...s.live, [rest.item.id]: { ...rest.item } } };
    case "item/agentMessage/delta":
    case "item/commandExecution/outputDelta": {
      const cur = s.live[rest.itemId];
      if (!cur) return s;
      const field = method === "item/agentMessage/delta" ? "text" : "aggregatedOutput";
      return { ...s, live: { ...s.live, [rest.itemId]: { ...cur, [field]: (cur[field] ?? "") + rest.delta } } };
    }
    case "item/reasoning/summaryTextDelta": {
      const cur = s.live[rest.itemId];
      if (!cur) return s;
      const summary = [...(cur.summary ?? [])];
      summary[rest.summaryIndex ?? 0] = (summary[rest.summaryIndex ?? 0] ?? "") + rest.delta;
      return { ...s, live: { ...s.live, [rest.itemId]: { ...cur, summary } } };
    }
    case "item/completed": {
      const live = { ...s.live };
      delete live[rest.item.id];
      return { ...s, live, chat: [...s.chat, { kind: "item", item: rest.item }] };
    }
    case "turn/plan/updated":
      return { ...s, chat: [...s.chat, { kind: "plan", plan: rest.plan, explanation: rest.explanation }] };
    case "error":
      return { ...s, chat: [...s.chat, { kind: "error", message: rest.error?.message ?? "error" }] };
    case "thread/tokenUsage/updated":
      return { ...s, tokenUsage: rest.tokenUsage };
    case "trace/paused":
      return { ...s, paused: rest };
    case "trace/resumed":
      return { ...s, paused: null };
    default:
      return s;
  }
}
