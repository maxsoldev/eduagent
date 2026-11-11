// Groups timeline events into agent runs and agent turns, so the timeline shows the loop's shape.
// A turn is one pass through the loop: one model call plus the tool calls it asks for. A run is one
// user message and all the turns after it, until the model replies with no tool calls. Each adapter's
// Explainer.boundary says which of its events start and end them; nothing here knows a protocol.
import type { TimelineEvent } from "./model";

export type Boundary = "runStart" | "runEnd" | "turnStart" | "turnEnd";
export type TurnGroup = { kind: "turn"; key: number; index: number; events: TimelineEvent[] };
export type RunItem = { kind: "event"; event: TimelineEvent } | TurnGroup;
export type RunGroup = { kind: "run"; key: number; index: number; items: RunItem[]; open: boolean };
export type TimelineItem = { kind: "event"; event: TimelineEvent } | RunGroup;

/** Fold events into runs that hold turns. A start closes the open group of its kind and opens a new
 *  one, so turns still split when no end event comes (the real pi sends no loopIteration). A run end
 *  also ends its turn. A turn start outside a run stays a plain event. `open`: the run has not ended. */
export function groupTimeline(
	events: TimelineEvent[],
	boundary: (e: TimelineEvent) => Boundary | null,
): TimelineItem[] {
	const items: TimelineItem[] = [];
	let run: RunGroup | null = null;
	let turn: TurnGroup | null = null;
	let runs = 0;
	for (const event of events) {
		const b = boundary(event);
		if (b === "runStart") {
			turn = null;
			run = { kind: "run", key: event.seq, index: ++runs, items: [], open: true };
			items.push(run);
		}
		if (b === "turnStart" && run) {
			turn = {
				kind: "turn",
				key: event.seq,
				index: run.items.filter((i) => i.kind === "turn").length + 1,
				events: [],
			};
			run.items.push(turn);
		}
		if (turn) turn.events.push(event);
		else if (run) run.items.push({ kind: "event", event });
		else items.push({ kind: "event", event });
		if (b === "turnEnd" || b === "runEnd") turn = null;
		if (b === "runEnd" && run) {
			run.open = false;
			run = null;
		}
	}
	return items;
}
