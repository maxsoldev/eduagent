// Seam A: edupi's trace events, {type: "trace", name, ...payload} lines next to pi's RPC events.
// They show what pi hides: the exact request body, each streamed chunk and the response usage.
// The faux provider records the request bodies it got, so the trace can be checked against them.
import { afterEach, expect, test } from "vitest";
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

const traces = (name: string) => edupi.seen.filter((m) => m.type === "trace" && m.name === name);

test("each model request is traced with its API, URL and the exact body the provider got", async () => {
  edupi = startEdupi({ responses: ["First answer.", "Second answer."] });
  await prompt("First question?");
  await prompt("Second question?");

  const recorded = edupi.requests();
  const requests = traces("modelRequest");
  expect(requests).toHaveLength(2);
  requests.forEach((r, i) => {
    expect(r).toEqual({ type: "trace", name: "modelRequest", api: "openai-completions", url: recorded[i].url, body: recorded[i].body });
  });
  expect(recorded[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
});

test("each streamed chunk is traced raw, in order, between the request and the reply's end", async () => {
  edupi = startEdupi({ responses: ["A reply streamed in chunks."] });
  await prompt("Hi?");

  const chunks = traces("streamEvent").map((m) => m.event);
  expect(chunks.length).toBeGreaterThan(2);
  for (const chunk of chunks) expect(chunk).toMatchObject({ id: "chatcmpl-faux", object: "chat.completion.chunk", model: "openai/gpt-6-luna" });
  expect(chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("")).toBe("A reply streamed in chunks.");
  expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason).toBe("stop");
  expect(chunks.at(-1).usage).toMatchObject({ prompt_tokens: expect.any(Number), completion_tokens: expect.any(Number) });

  const order = edupi.seen.map((m) => (m.type === "trace" ? m.name : m.type));
  expect(order.indexOf("modelRequest")).toBeLessThan(order.indexOf("streamEvent"));
  expect(order.lastIndexOf("streamEvent")).toBeLessThan(order.indexOf("message_end", order.indexOf("modelRequest")));
});

test("each model response is traced with pi's usage, taken from the last chunk", async () => {
  edupi = startEdupi({ responses: ["Short reply."] });
  await prompt("Hi?");

  const [response] = traces("modelResponse");
  const usageChunk = traces("streamEvent").map((m) => m.event).find((c) => c.usage).usage;
  const reply = edupi.seen.find((m) => m.type === "message_end" && m.message.role === "assistant")!.message;
  expect(response).toEqual({
    type: "trace", name: "modelResponse", stopReason: "stop", responseId: "chatcmpl-faux",
    content: [{ type: "text", text: "Short reply." }], usage: reply.usage, seconds: expect.any(Number),
  });
  expect(response.usage).toMatchObject({ input: usageChunk.prompt_tokens, output: usageChunk.completion_tokens,
    totalTokens: usageChunk.prompt_tokens + usageChunk.completion_tokens });
});

test("a failed model call is traced as a response with the error", async () => {
  edupi = startEdupi({ responses: [] }); // the faux provider answers HTTP 500
  await prompt("Hi?");

  expect(traces("modelRequest")).toHaveLength(1);
  const [response] = traces("modelResponse");
  expect(response).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("No more faux responses queued") });
});

test("trace events still arrive after new_session, for the new session's requests", async () => {
  edupi = startEdupi({ responses: ["Old answer.", "New answer."] });
  await prompt("Old question?");
  await edupi.command("new_session");
  await prompt("New question?");

  const requests = traces("modelRequest");
  expect(requests).toHaveLength(2);
  expect(requests[1].body).toEqual(edupi.requests()[1].body);
  expect(requests[1].body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "New question?" }] }]);
  expect(traces("modelResponse").at(-1)).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "New answer." }] });
});
