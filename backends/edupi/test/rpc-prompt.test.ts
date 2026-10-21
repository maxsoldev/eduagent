// Seam A: a prompt over pi's RPC protocol, answered by the faux provider.
import { afterEach, expect, test } from "vitest";
import { startEdupi, type Message, type RpcClient } from "./rpc-client.ts";

let edupi: RpcClient;
afterEach(async () => {
  await edupi?.close();
});

/** pi's message types (trace messages are edupi's extras, left out), with the subtype for message_update. */
function eventTypes(seen: Message[]): string[] {
  return seen.filter((m) => m.type !== "trace").map((m) =>
    m.type === "response" ? `response ${m.command}`
      : m.type === "message_update" ? `message_update ${m.assistantMessageEvent.type}`
        : m.type === "message_start" || m.type === "message_end" ? `${m.type} ${m.message.role}`
          : m.type,
  );
}

test("a prompt streams pi's agent, turn and message events and ends with the reply", async () => {
  edupi = startEdupi({ responses: ["Hello from the faux model. It streams in small chunks."] });

  edupi.sendLine(JSON.stringify({ id: "1", type: "prompt", message: "Say hello." }));
  await edupi.until("agent_settled");

  const types = eventTypes(edupi.seen).filter((t, i, all) => t !== all[i - 1]); // collapse repeated text_delta
  expect(types).toEqual([
    "response prompt",
    "agent_start",
    "turn_start",
    "message_start system", // the tool declarations (toolsAdded), before the first prompt only
    "message_end system",
    "message_start user",
    "message_end user",
    "message_start assistant",
    "message_update text_start",
    "message_update text_delta",
    "message_update text_end",
    "message_end assistant",
    "turn_end",
    "agent_end",
    "agent_settled",
  ]);

  expect(edupi.seen[0]).toEqual({ id: "1", type: "response", command: "prompt", success: true, data: { disposition: "started" } });
  const user = edupi.seen.find((m) => m.type === "message_end" && m.message.role === "user")!.message;
  expect(user).toEqual({ role: "user", content: [{ type: "text", text: "Say hello." }], timestamp: expect.any(Number) });

  const deltas = edupi.seen.filter((m) => m.assistantMessageEvent?.type === "text_delta");
  expect(deltas.length).toBeGreaterThan(1); // streamed, not sent in one piece
  expect(deltas.map((m) => m.assistantMessageEvent.delta).join("")).toBe("Hello from the faux model. It streams in small chunks.");
  for (const m of edupi.seen.filter((m) => m.type === "message_update")) {
    expect(Object.keys(m).sort()).toEqual(["assistantMessageEvent", "type", "usage"]); // pi's wire shape: no partial message
  }

  const reply = edupi.seen.find((m) => m.type === "message_end" && m.message.role === "assistant")!.message;
  expect(reply).toMatchObject({
    role: "assistant",
    content: [{ type: "text", text: "Hello from the faux model. It streams in small chunks." }],
    api: "openai-completions",
    provider: "openrouter",
    model: "openai/gpt-6-luna",
    stopReason: "stop",
    thinkingLevel: "off",
  });
  expect(reply.usage.output).toBeGreaterThan(0);

  const end = edupi.seen.find((m) => m.type === "agent_end")!;
  expect(end.willRetry).toBe(false);
  expect(end.messages.map((m: Message) => m.role)).toEqual(["system", "user", "assistant"]);
  const system = edupi.seen.find((m) => m.type === "message_end" && m.message.role === "system")!.message;
  expect(system.toolsAdded.map((t: Message) => t.name)).toEqual(["read", "bash", "edit", "write"]);
  expect(edupi.seen.find((m) => m.type === "turn_end")).toMatchObject({ message: reply, toolResults: [] });
  expect(edupi.seen.at(-1)).toEqual({ type: "agent_settled", aborted: false });
});

test("get_state answers with pi's session state, before and after a prompt", async () => {
  edupi = startEdupi({ responses: ["Hi."] });

  const before = await edupi.command("get_state");
  expect(before).toMatchObject({ type: "response", command: "get_state", success: true });
  expect(before.data).toEqual({
    model: {
      id: "openai/gpt-6-luna",
      name: "openai/gpt-6-luna",
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    },
    thinkingLevel: "off",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    sessionFile: expect.any(String),
    sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    autoCompactionEnabled: false,
    messageCount: 0,
    pendingMessageCount: 0,
  });

  edupi.sendLine(JSON.stringify({ type: "prompt", message: "Hello?" }));
  await edupi.until("agent_settled");
  const after = await edupi.command("get_state");
  expect(after.data).toMatchObject({ isStreaming: false, messageCount: 3, sessionId: before.data.sessionId }); // system, user, assistant
});
