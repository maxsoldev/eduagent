// Seam A: what edupi sends to the model. The faux provider stands in for OpenRouter's Chat
// Completions endpoint and records each request.
import { afterEach, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEdupi, type RpcClient } from "./rpc-client.ts";

let edupi: RpcClient;
afterEach(async () => {
  await edupi?.close();
});

async function prompt(message: string) {
  const settled = edupi.seen.filter((m) => m.type === "agent_settled").length;
  edupi.sendLine(JSON.stringify({ type: "prompt", message }));
  await edupi.until(() => edupi.seen.filter((m) => m.type === "agent_settled").length > settled);
}

test("each request is a stateless Chat Completions body on OpenRouter with the whole conversation", async () => {
  edupi = startEdupi({ responses: ["First answer.", "Second answer."] });
  await prompt("First question?");
  await prompt("Second question?");

  const [first, second] = edupi.requests();
  expect(first.url).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect(first.body).toEqual({
    model: "openai/gpt-6-luna",
    messages: [{ role: "user", content: [{ type: "text", text: "First question?" }] }],
    stream: true,
    stream_options: { include_usage: true },
    store: false,
    max_completion_tokens: 16384,
  });
  expect(second.body.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "First question?" }] },
    { role: "assistant", content: "First answer." },
    { role: "user", content: [{ type: "text", text: "Second question?" }] },
  ]);
});

test("any OpenRouter model id is accepted with --model", async () => {
  edupi = startEdupi({ responses: ["Hi."] }, ["--model", "anthropic/claude-sonnet-5"]);
  const state = await edupi.command("get_state");
  expect(state.data.model).toMatchObject({ id: "anthropic/claude-sonnet-5", provider: "openrouter", api: "openai-completions" });
  await prompt("Hi?");
  expect(edupi.requests()[0].body.model).toBe("anthropic/claude-sonnet-5");
  expect(edupi.seen.find((m) => m.type === "message_end" && m.message.role === "assistant")!.message.model).toBe("anthropic/claude-sonnet-5");
});

test("unknown commands and bad JSON get pi's error responses", async () => {
  edupi = startEdupi({ responses: [] });
  expect(await edupi.command("get_tree")).toEqual({ id: "1", type: "response", command: "get_tree", success: false, error: "Unknown command: get_tree" });
  edupi.sendLine("not json");
  const parse = await edupi.until((m) => m.command === "parse");
  expect(parse).toEqual({ type: "response", command: "parse", success: false, error: expect.stringMatching(/^Failed to parse command: /) });
});

test("without an API key a prompt is refused before the run starts", async () => {
  const home = mkdtempSync(join(tmpdir(), "edupi-home-"));
  const proc = spawn(process.execPath, [new URL("../bin/edupi.mjs", import.meta.url).pathname, "--mode", "rpc"],
    { env: { ...process.env, OPENROUTER_API_KEY: "", EDUPI_CODING_AGENT_DIR: home } });
  let out = "";
  const firstLine = new Promise((resolve) => proc.stdout.on("data", (d) => (out += d) && out.includes("\n") && resolve(out)));
  proc.stdin.write(`${JSON.stringify({ id: "1", type: "prompt", message: "Hi" })}\n`);
  await firstLine;
  proc.stdin.end();
  await new Promise((r) => proc.once("close", r));
  const lines = out.trim().split("\n").map((l) => JSON.parse(l));
  expect(lines).toEqual([{ id: "1", type: "response", command: "prompt", success: false, error: expect.stringMatching(/^No API key found for openrouter\./) }]);
});
