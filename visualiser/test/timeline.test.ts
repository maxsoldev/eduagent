// groupTimeline folds each backend's events into agent runs and agent turns. The event orders below
// follow the backends: pi's agent-loop.ts (turn_end, then loopIteration) and educodex's core/turn.py.
import { describe, expect, test } from "vitest";
import { codexExplainer } from "../src/adapters/codex/explain";
import { piExplainer } from "../src/adapters/pi/explain";
import type { TimelineEvent } from "../src/view/model";
import { groupTimeline, type TimelineItem } from "../src/view/timeline";

let seq = 0;
const ev = (name: string, data: object = {}): TimelineEvent => {
	const trace = name.startsWith("trace ");
	return { seq: ++seq, ts: seq, name: trace ? name.slice(6) : name, trace, data };
};

// A compact picture of the groups: runs and turns as nested arrays, plain events as names.
const shape = (items: TimelineItem[]): unknown[] =>
	items.map((i) =>
		i.kind === "event"
			? i.event.name
			: {
					run: i.index,
					open: i.open,
					items: i.items.map((t) =>
						t.kind === "event" ? t.event.name : { turn: t.index, events: t.events.map((e) => e.name) },
					),
				},
	);

describe("groupTimeline", () => {
	test("pi: agent_start..agent_end is a run; turn_start..loopIteration is a turn", () => {
		const events = [
			ev("trace toolsRegistered"),
			ev("agent_start"),
			ev("turn_start"),
			ev("trace modelRequest"),
			ev("tool_execution_start"),
			ev("turn_end"),
			ev("trace loopIteration"),
			ev("turn_start"),
			ev("trace modelRequest"),
			ev("turn_end"),
			ev("trace loopIteration"),
			ev("agent_end"),
			ev("agent_settled"),
		];
		expect(shape(groupTimeline(events, piExplainer.boundary))).toEqual([
			"toolsRegistered",
			{
				run: 1,
				open: false,
				items: [
					"agent_start",
					{ turn: 1, events: ["turn_start", "modelRequest", "tool_execution_start", "turn_end", "loopIteration"] },
					{ turn: 2, events: ["turn_start", "modelRequest", "turn_end", "loopIteration"] },
					"agent_end",
				],
			},
			"agent_settled",
		]);
	});

	test("pi: a failed turn without loopIteration ends with its run", () => {
		const events = [ev("agent_start"), ev("turn_start"), ev("turn_end"), ev("agent_end"), ev("agent_start")];
		expect(shape(groupTimeline(events, piExplainer.boundary))).toEqual([
			{ run: 1, open: false, items: ["agent_start", { turn: 1, events: ["turn_start", "turn_end", "agent_end"] }] },
			{ run: 2, open: true, items: ["agent_start"] },
		]);
	});

	test("real pi (no trace events): the next turn_start closes the turn", () => {
		const events = [
			ev("agent_start"),
			ev("turn_start"),
			ev("turn_end"),
			ev("turn_start"),
			ev("turn_end"),
			ev("agent_end"),
		];
		expect(shape(groupTimeline(events, piExplainer.boundary))).toEqual([
			{
				run: 1,
				open: false,
				items: [
					"agent_start",
					{ turn: 1, events: ["turn_start", "turn_end"] },
					{ turn: 2, events: ["turn_start", "turn_end", "agent_end"] },
				],
			},
		]);
	});

	test("Codex: turn/started..turn/completed is a run; modelRequest..loopIteration is a turn", () => {
		const events = [
			ev("turn/started"),
			ev("trace skillsLoaded"),
			ev("trace paused", { breakpoint: "beforeModelRequest" }),
			ev("trace resumed"),
			ev("trace modelRequest"),
			ev("trace toolDispatch"),
			ev("trace loopIteration"),
			ev("trace compactionRequest"),
			ev("trace modelRequest"),
			ev("trace loopIteration"),
			ev("turn/completed"),
		];
		expect(shape(groupTimeline(events, codexExplainer.boundary))).toEqual([
			{
				run: 1,
				open: false,
				items: [
					"turn/started",
					"skillsLoaded",
					"paused",
					"resumed",
					{ turn: 1, events: ["modelRequest", "toolDispatch", "loopIteration"] },
					"compactionRequest",
					{ turn: 2, events: ["modelRequest", "loopIteration"] },
					"turn/completed",
				],
			},
		]);
	});
});
