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

test("edupi's model, tool, prompt and skill trace events match the protocol fixtures", async () => {
  const bash = { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "echo hi" } };
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "edupi-test-")));
  const skill = join(dir, "home", "agent", "skills", "greet");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: greet\ndescription: Greets the user.\n---\n\nSay hi.\n");
  edupi = startEdupi({ responses: [{ content: [bash], stopReason: "toolUse" }, "Hello there."] }, [], { dir });
  edupi.sendLine(JSON.stringify({ type: "prompt", message: "Hi?" }));
  await edupi.until("agent_settled");

  const first = (name: string, where: (m: Message) => boolean = () => true) =>
    edupi.seen.find((m) => m.type === "trace" && m.name === name && where(m));
  const actual: Record<string, Message | undefined> = {
    modelRequest: first("modelRequest"),
    toolDispatch: first("toolDispatch"),
    toolOutput: first("toolOutput"),
    streamEvent: first("streamEvent", (m) => Boolean(m.event.choices[0]?.delta?.content)), // a text chunk, as in the fixture
    modelResponse: first("modelResponse"),
    promptAssembled: first("promptAssembled"),
    skillsLoaded: first("skillsLoaded"),
  };
  expect(actual.skillsLoaded!.skills.map((s: Message) => s.name)).toEqual(["greet"]);
  expect(Object.keys(actual).sort()).toEqual(Object.keys(shared).sort()); // every shared event is checked
  for (const [name, message] of Object.entries(actual)) {
    expect(message, name).toBeDefined();
    expect(shapeErrors(fixture(name), message), name).toEqual([]);
    for (const [field, type] of Object.entries(shared[name])) expect(jsonType(message![field]), `${name}.${field}`).toBe(type);
  }
});
