// Seam A: pi's steering and follow-up queues, abort and thinking level over pi's RPC protocol.
// The faux provider scripts the replies; a slow bash call or a slow stream gives the test time
// to send commands while the run is active. Expected shapes come from real pi transcripts
// (eduagent-spec4-notes/samples/pi-rpc-queues-abort.out.jsonl).
import { afterEach, expect, test } from "vitest";
import { startEdupi, type Message, type RpcClient } from "./rpc-client.ts";

let edupi: RpcClient;
afterEach(async () => {
  await edupi?.close();
});

const call = (id: string, name: string, args: object) => ({ type: "toolCall", id, name, arguments: args });
const toolUse = (...calls: object[]) => ({ content: calls, stopReason: "toolUse" });
const slowBash = toolUse(call("call_s", "bash", { command: "sleep 0.8; echo done" }));

const settledCount = () => edupi.seen.filter((m) => m.type === "agent_settled").length;
const untilSettled = (count = settledCount() + 1) => edupi.until(() => settledCount() >= count, 15_000);

/** pi's events, one short line each; queue updates show both queues, user messages their text. */
function eventOrder(from = 0): string[] {
  const text = (m: Message) => m.content.map((c: Message) => c.text).join("");
  return edupi.seen.slice(from).filter((m) => !["trace", "message_update", "response", "tool_execution_update"].includes(m.type)).map((m) =>
    m.type === "queue_update" ? `queue_update [${m.steering.join("|")}] [${m.followUp.join("|")}]`
      : m.type === "tool_execution_start" || m.type === "tool_execution_end" ? `${m.type} ${m.toolCallId}`
        : m.type === "message_start" || m.type === "message_end"
          ? `${m.type} ${m.message.role}${m.message.role === "user" ? ` ${text(m.message)}` : ""}`
          : m.type === "agent_settled" ? `agent_settled ${m.aborted}` : m.type);
}

test("steer, follow_up and prompt with streamingBehavior queue during a tool call; each queued message gets its own turn", async () => {
  edupi = startEdupi({ responses: [slowBash, "Ack steer.", "Ack prompt as steer.", "Ack follow."] });
  edupi.sendLine(JSON.stringify({ id: "a", type: "prompt", message: "run slow" }));
  await edupi.until("tool_execution_start");

  const replies = Promise.all([
    edupi.command("steer", { message: "steer msg" }),
    edupi.command("follow_up", { message: "follow msg" }),
    edupi.command("prompt", { message: "prompt as steer", streamingBehavior: "steer" }),
    edupi.command("prompt", { message: "no behaviour" }),
  ]);
  const [steer, followUp, promptSteer, rejected] = await replies;
  expect(steer).toEqual({ id: "1", type: "response", command: "steer", success: true, data: { disposition: "queued" } });
  expect(followUp).toEqual({ id: "2", type: "response", command: "follow_up", success: true, data: { disposition: "queued" } });
  expect(promptSteer).toEqual({ id: "3", type: "response", command: "prompt", success: true, data: { disposition: "queued" } });
  expect(rejected).toEqual({ id: "4", type: "response", command: "prompt", success: false,
    error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message." });
  expect((await edupi.command("get_state")).data).toMatchObject({ isStreaming: true, pendingMessageCount: 3,
    steeringMode: "one-at-a-time", followUpMode: "one-at-a-time" });

  await untilSettled(1);
  // Steering waits for the running tool, then goes in before the next model call, one message per
  // turn. The follow-up waits until the agent would stop. All of it is one run.
  expect(eventOrder()).toEqual([
    "agent_start", "turn_start",
    "message_start system", "message_end system", "message_start user run slow", "message_end user run slow",
    "message_start assistant", "message_end assistant",
    "tool_execution_start call_s",
    "queue_update [steer msg] []",
    "queue_update [steer msg] [follow msg]",
    "queue_update [steer msg|prompt as steer] [follow msg]",
    "tool_execution_end call_s", "message_start toolResult", "message_end toolResult", "turn_end",
    "turn_start", "queue_update [prompt as steer] [follow msg]",
    "message_start user steer msg", "message_end user steer msg", "message_start assistant", "message_end assistant", "turn_end",
    "turn_start", "queue_update [] [follow msg]",
    "message_start user prompt as steer", "message_end user prompt as steer", "message_start assistant", "message_end assistant", "turn_end",
    "turn_start", "queue_update [] []",
    "message_start user follow msg", "message_end user follow msg", "message_start assistant", "message_end assistant", "turn_end",
    "agent_end", "agent_settled false",
  ]);

  // The steering message reached the model after the tool result, before the next reply.
  const bodies = edupi.requests().map((r) => r.body);
  expect(bodies).toHaveLength(4);
  expect(bodies[1].messages.slice(-2)).toEqual([
    { role: "tool", content: "done\n", tool_call_id: "call_s" },
    { role: "user", content: [{ type: "text", text: "steer msg" }] },
  ]);
  expect(bodies[3].messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "follow msg" }] });
  expect((await edupi.command("get_state")).data).toMatchObject({ isStreaming: false, pendingMessageCount: 0 });
});

test("a follow-up sent while the reply streams runs after that turn, in the same run", async () => {
  edupi = startEdupi({ tokensPerSecond: 40, responses: ["A first answer that streams slowly enough for the test.", "Second answer."] });
  edupi.sendLine(JSON.stringify({ type: "prompt", message: "first" }));
  await edupi.until((m) => m.type === "message_update" && m.assistantMessageEvent.type === "text_delta");
  await edupi.command("follow_up", { message: "and then this" });
  await untilSettled(1);

  expect(eventOrder().slice(6)).toEqual([
    "message_start assistant", "queue_update [] [and then this]", "message_end assistant", "turn_end",
    "turn_start", "queue_update [] []", "message_start user and then this", "message_end user and then this",
    "message_start assistant", "message_end assistant", "turn_end",
    "agent_end", "agent_settled false",
  ]);
  const agentEnd = edupi.seen.find((m) => m.type === "agent_end")!;
  expect(agentEnd.messages.map((m: Message) => m.role)).toEqual(["system", "user", "assistant", "user", "assistant"]);
});

test("abort mid-stream: the reply ends as aborted, then agent_settled, then the abort response; queued messages stay", async () => {
  edupi = startEdupi({ tokensPerSecond: 20, responses: ["one two three four five six seven eight nine ten eleven twelve", "After."] });
  edupi.sendLine(JSON.stringify({ type: "prompt", message: "count slowly" }));
  await edupi.until((m) => m.type === "message_update" && m.assistantMessageEvent.type === "text_delta");
  await edupi.command("follow_up", { message: "later" });
  const from = edupi.seen.length;
  const reply = await edupi.command("abort");
  expect(reply).toEqual({ id: "2", type: "response", command: "abort", success: true });

  expect(eventOrder(from)).toEqual(["message_end assistant", "turn_end", "agent_end", "agent_settled true"]);
  const end = edupi.seen.slice(from).find((m) => m.type === "message_end")!.message;
  expect(end).toMatchObject({ role: "assistant", stopReason: "aborted", errorMessage: "Request was aborted" });
  expect(end.content[0].text.length).toBeGreaterThan(0); // the partial text is kept
  expect("one two three four five six seven eight nine ten eleven twelve".startsWith(end.content[0].text)).toBe(true);
  // The abort response is the last line: it waits until the run has settled.
  expect(edupi.seen.at(-1)).toBe(reply);
  // pi's abort does not clear the queues.
  expect((await edupi.command("get_state")).data).toMatchObject({ isStreaming: false, pendingMessageCount: 1 });
});

test("abort mid-tool: the running command is killed, its result says so, and the next model call returns aborted at once", async () => {
  edupi = startEdupi({ responses: [toolUse(call("call_slow", "bash", { command: "echo started; sleep 5; echo finished" })), "Still here."] });
  edupi.sendLine(JSON.stringify({ type: "prompt", message: "Run a slow command." }));
  await edupi.until((m) => m.type === "tool_execution_update" && m.partialResult.content.length > 0);
  const started = Date.now();
  await edupi.command("abort");
  expect(Date.now() - started).toBeLessThan(3000); // the sleep did not run to its end

  const end = edupi.seen.find((m) => m.type === "tool_execution_end")!;
  expect(end).toMatchObject({ toolCallId: "call_slow", isError: true, result: { content: [{ type: "text", text: "started\n\n\nCommand aborted" }] } });
  expect(eventOrder().slice(8)).toEqual([
    "tool_execution_start call_slow", "tool_execution_end call_slow", "message_start toolResult", "message_end toolResult", "turn_end",
    "turn_start", "message_start assistant", "message_end assistant", "turn_end", "agent_end", "agent_settled true",
  ]);
  const last = edupi.seen.filter((m) => m.type === "message_end").at(-1)!.message;
  expect(last).toMatchObject({ role: "assistant", stopReason: "aborted", content: [] });
  expect(edupi.requests()).toHaveLength(1); // the aborted call never reached the model

  // The session goes on: the next prompt runs normally.
  edupi.sendLine(JSON.stringify({ type: "prompt", message: "Are you still there?" }));
  await untilSettled(2);
  expect(edupi.seen.filter((m) => m.type === "agent_settled").at(-1)).toEqual({ type: "agent_settled", aborted: false });
});

test("new_session during a run aborts the run first, as pi does", async () => {
  edupi = startEdupi({ responses: [slowBash, "Never sent."] });
  edupi.sendLine(JSON.stringify({ type: "prompt", message: "run slow" }));
  await edupi.until("tool_execution_start");
  const reply = await edupi.command("new_session");
  expect(reply).toMatchObject({ command: "new_session", success: true, data: { cancelled: false } });
  const settled = edupi.seen.findIndex((m) => m.type === "agent_settled");
  expect(edupi.seen[settled]).toEqual({ type: "agent_settled", aborted: true });
  expect(settled).toBeLessThan(edupi.seen.indexOf(reply));
  expect(edupi.requests()).toHaveLength(1);
});
