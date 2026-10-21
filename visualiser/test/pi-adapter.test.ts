// Seam C: transcripts recorded from the real pi (pinned commit, see fixtures/pi/meta.json) go
// through the pi adapter into the neutral view model. Re-record with test/record-pi.mjs.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { createPiMapping } from "../src/adapters/pi/mapping";
import { initialView, reduceView, type Entry, type View } from "../src/view/model";

const lines = (file: string) =>
  readFileSync(new URL(`fixtures/pi/${file}`, import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

function replay(file: string, upTo?: number): View {
  const map = createPiMapping();
  return lines(file).slice(0, upTo).flatMap(map).reduce(reduceView, initialView);
}

const kinds = (entries: Entry[]) => entries.map((e) => e.kind);

describe("pi adapter on a plain reply and a reply with tool calls", () => {
  const view = replay("chat.out.jsonl");

  test("get_state names the session; each prompt is one completed turn", () => {
    expect(view.sessionId).toBe("01a15edd-fec2-77f8-81e0-496f2a56d4df");
    expect(view.turns.map((t) => t.status)).toEqual(["completed", "completed"]);
    expect(view.running).toBe(false);
  });

  test("a turn lasts from its first message to the end of its last one", () => {
    // Turn 1: user at ...442, reply at ...503 taking 18 ms. Turn 2: user at ...522, last reply at ...533 taking 2 ms.
    expect(view.turns.map((t) => t.durationMs)).toEqual([79, 13]);
  });

  test("the reply streams in and ends as the final text", () => {
    const first = view.turns[0].entries;
    expect(kinds(first)).toEqual(["user", "assistant"]);
    expect(first[0]).toMatchObject({ kind: "user", text: "Say hello." });
    expect(first[1]).toMatchObject({ kind: "assistant", text: "Hello from the fake model.", streaming: false });

    const midStream = replay("chat.out.jsonl", 11).turns[0]; // up to the first text_delta
    expect(midStream.status).toBe("running");
    expect(midStream.entries[1]).toMatchObject({ kind: "assistant", text: "Hello", streaming: true });
  });

  test("parallel tool calls carry name, arguments, output and status", () => {
    const second = view.turns[1].entries;
    expect(kinds(second)).toEqual(["user", "tool", "tool", "tool", "assistant"]);
    const [bash, read, missing] = second.slice(1, 4);
    expect(bash).toMatchObject({ kind: "tool", id: "call_1", name: "bash", toolKind: "shell", title: "echo hi",
      arguments: { command: "echo hi" }, output: "hi\n", status: "completed", exitCode: 0, streaming: false });
    expect(read).toMatchObject({ kind: "tool", name: "read", toolKind: "other", title: "a.txt", output: "alpha\nbeta\n", status: "completed" });
    expect(missing).toMatchObject({ kind: "tool", name: "read", status: "failed" });
    expect(missing.kind === "tool" && missing.output).toContain("ENOENT: no such file or directory");
    expect(second[4]).toMatchObject({ kind: "assistant", text: "a.txt has two lines; missing.txt does not exist." });
  });

  test("a running tool streams its partial output", () => {
    const running = replay("chat.out.jsonl", 41).turns[1].entries; // up to bash's first update
    expect(running.filter((e) => e.kind === "tool").map((e) => e.kind === "tool" && e.status)).toEqual(["running", "running", "running"]);
    const partial = replay("chat.out.jsonl", 44).turns[1].entries.find((e) => e.id === "call_1");
    expect(partial).toMatchObject({ status: "running", output: "hi\n", streaming: true });
  });
});

describe("pi adapter on a failed compaction and an abort during a tool call", () => {
  const view = replay("abort.out.jsonl");
  const [failed, aborted, next] = view.turns;

  test("a compaction that fails shows pi's error instead of a compaction", () => {
    expect(failed.entries).toEqual([{ kind: "notice", id: expect.any(String), level: "error", source: "backend",
      text: "Compaction failed: Nothing to compact (session too small)" }]);
  });

  test("the aborted run ends as an interrupted turn; the next prompt runs normally", () => {
    expect(view.turns.map((t) => t.status)).toEqual([null, "interrupted", "completed"]);
    expect(kinds(next.entries)).toEqual(["user", "assistant"]);
    expect(next.entries[1]).toMatchObject({ text: "Still here." });
  });

  test("the running tool keeps its partial output and ends as aborted", () => {
    expect(aborted.entries.find((e) => e.kind === "tool")).toMatchObject({ name: "bash", status: "aborted", streaming: false,
      output: "started\n\n\nCommand aborted" });
  });

  test("pi's error for the cancelled model call shows as a backend notice", () => {
    expect(aborted.entries.at(-1)).toMatchObject({ kind: "notice", level: "error", source: "backend", text: "This operation was aborted" });
  });
});

describe("pi adapter on a manual compaction", () => {
  const view = replay("compact.out.jsonl");
  const compactions = view.turns.flatMap((t) => t.entries).filter((e) => e.kind === "compaction");

  test("compaction_start and compaction_end become one compaction entry with its reason", () => {
    expect(compactions).toEqual([{ kind: "compaction", id: expect.any(String), streaming: false, reason: "manual" }]);
    const during = replay("compact.out.jsonl", 43).turns.flatMap((t) => t.entries).filter((e) => e.kind === "compaction");
    expect(during).toMatchObject([{ streaming: true, reason: "manual" }]);
  });

  test("the compaction sits between the turns before it and the turn after it", () => {
    expect(view.turns.map((t) => t.status)).toEqual(["completed", "completed", "completed", null, "completed"]);
    expect(view.turns[3].entries.map((e) => e.kind)).toEqual(["compaction"]);
    expect(view.turns[4].entries[1]).toMatchObject({ kind: "assistant", text: "After the compaction." });
  });

  test("the timeline keeps the summary pi wrote", () => {
    const end = view.events.find((e) => e.name === "compaction_end");
    expect(end).toMatchObject({ trace: false, sessionId: view.sessionId, data: { reason: "manual", aborted: false } });
    expect(end?.data.result.summary).toBe("## Goal\nSUMMARY OF THE EARLIER TURNS");
  });
});
