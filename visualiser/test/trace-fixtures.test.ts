// Seam C on the protocol spec's trace fixtures (protocol/fixtures/trace/): both adapters turn a
// backend's native trace message into the same timeline event, so the Inspector code is shared.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { codexActions } from "../src/adapters/codex/mapping";
import { createPiMapping } from "../src/adapters/pi/mapping";
import type { Json, TimelineEvent, ViewAction } from "../src/view/model";
import { jsonType } from "../../protocol/shape";

const FIXTURES = new URL("../../protocol/fixtures/trace/", import.meta.url);
const read = (path: string) => JSON.parse(readFileSync(new URL(path, FIXTURES), "utf8"));
const shared: Record<string, Record<string, string>> = read("shared.json");

const eventOf = (actions: ViewAction[]) =>
	(actions.find((a) => a.type === "event") as Extract<ViewAction, { type: "event" }>).event as TimelineEvent;

test.each(Object.keys(shared))("%s: both adapters give a trace event with the shared fields", (name) => {
	const codex = eventOf(codexActions(read(`educodex/${name}.json`)));
	const pi = eventOf(createPiMapping()(read(`edupi/${name}.json`)));
	for (const event of [codex, pi]) {
		expect(event).toMatchObject({ name, trace: true });
		for (const [field, type] of Object.entries(shared[name]))
			expect(jsonType((event.data as Json)[field]), field).toBe(type);
	}
	expect(pi.data).not.toHaveProperty("type"); // the pi tag and name are not part of the payload
	expect(pi.data).not.toHaveProperty("name");
});

test("the model request names its API: Responses for educodex, Chat Completions for edupi", () => {
	expect(eventOf(codexActions(read("educodex/modelRequest.json"))).data.api).toBe("openai-responses");
	expect(eventOf(createPiMapping()(read("edupi/modelRequest.json"))).data.api).toBe("openai-completions");
});
