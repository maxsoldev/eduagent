// Seam A against the protocol spec: edupi's trace events have the shapes of the fixtures in
// protocol/fixtures/trace/edupi/, and the shared fields of protocol/fixtures/trace/shared.json.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { jsonType, shapeErrors } from "../../../protocol/shape.ts";
import { startEdupi, type Message, type RpcClient } from "./rpc-client.ts";

const FIXTURES = new URL("../../../protocol/fixtures/trace/", import.meta.url);
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`edupi/${name}.json`, FIXTURES), "utf8"));
const shared: Record<string, Record<string, string>> = JSON.parse(readFileSync(new URL("shared.json", FIXTURES), "utf8"));

let edupi: RpcClient;
afterEach(async () => {
  await edupi?.close();
});

test("edupi's model trace events match the protocol fixtures", async () => {
  edupi = startEdupi({ responses: ["Hello there."] });
  edupi.sendLine(JSON.stringify({ type: "prompt", message: "Hi?" }));
  await edupi.until("agent_settled");

  const first = (name: string, where: (m: Message) => boolean = () => true) =>
    edupi.seen.find((m) => m.type === "trace" && m.name === name && where(m));
  const actual: Record<string, Message | undefined> = { // the compaction events are in the next test
    modelRequest: first("modelRequest"),
    streamEvent: first("streamEvent", (m) => Boolean(m.event.choices[0]?.delta?.content)), // a text chunk, as in the fixture
    modelResponse: first("modelResponse"),
  };
  for (const [name, message] of Object.entries(actual)) {
    expect(message, name).toBeDefined();
    expect(shapeErrors(fixture(name), message), name).toEqual([]);
    for (const [field, type] of Object.entries(shared[name])) expect(jsonType(message![field]), `${name}.${field}`).toBe(type);
  }
});

test("edupi's compaction trace events match the protocol fixtures", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "edupi-test-")));
  mkdirSync(join(dir, "home", "agent"), { recursive: true });
  writeFileSync(join(dir, "home", "agent", "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 6 } }));
  edupi = startEdupi({ responses: ["Hello there.", "Hello again.", "## Goal\nSay hello."] }, [], { dir });
  for (const message of ["Hi?", "Hi again?"]) {
    const settled = edupi.seen.filter((m) => m.type === "agent_settled").length;
    edupi.sendLine(JSON.stringify({ type: "prompt", message }));
    await edupi.until(() => edupi.seen.filter((m) => m.type === "agent_settled").length > settled);
  }
  await edupi.command("compact");

  for (const name of ["compactionRequest", "compacted"]) {
    const message = edupi.seen.find((m) => m.type === "trace" && m.name === name);
    expect(message, name).toBeDefined();
    expect(shapeErrors(fixture(name), message), name).toEqual([]);
    for (const [field, type] of Object.entries(shared[name])) expect(jsonType(message![field]), `${name}.${field}`).toBe(type);
  }
});
