import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_DIR } from "./env";

// An edupi viewer through the launcher. The test entry "edupi" runs edupi with the faux provider
// (backends/edupi/examples/faux/demo.json), so no model is called. edupi speaks pi's RPC protocol,
// so the viewer uses the same pi adapter as for the real pi.

async function send(page: Page, text: string) {
  await page.getByTestId("composer").fill(text);
  await page.getByTestId("send").click();
}

test("pick edupi in the picker and chat: the reply streams in over pi's RPC protocol", async ({ page }) => {
  await page.goto("/");
  const entry = page.getByTestId("backend-edupi");
  await expect(entry).toContainText("pi");
  await entry.getByRole("button", { name: "Open" }).click();
  await expect(page.getByTestId("conn")).toHaveText("open");
  await expect(page.getByTestId("backend-name")).toHaveText("edupi");

  await send(page, "Say hello.");
  await expect(page.getByTestId("agent-message").last()).toHaveText(/Hello from edupi\. This reply comes from the faux provider/);
  await expect(page.getByTestId("turn-sep").last()).toContainText("turn completed");

  await send(page, "And again?");
  await expect(page.getByTestId("turn-sep")).toHaveCount(2);
  await expect(page.getByTestId("agent-message").last()).toHaveText(/This is the second reply\./);

  // The reply came as pi's streaming events: text deltas between message_start and message_end.
  await page.getByTestId("tab-Protocol").click();
  const wire = page.getByTestId("protocol-view");
  await expect(wire).toContainText("pi RPC");
  for (const title of ["get_state", "prompt", "response prompt", "agent_start", "message_update", "message_end", "agent_settled"])
    await expect(wire.locator(".t-title").getByText(title, { exact: true }).first()).toBeVisible();
  await wire.getByPlaceholder("filter…").fill("text_delta");
  expect(await wire.locator(".t-title").getByText("message_update", { exact: true }).count()).toBeGreaterThan(2);
});

test("new thread starts a new edupi session; each session is a pi session file in edupi's home", async ({ page }) => {
  await page.goto("/?backend=edupi");
  await expect(page.getByTestId("conn")).toHaveText("open");
  await send(page, "Session one, please.");
  await expect(page.getByTestId("turn-sep")).toHaveCount(1);

  await page.getByTestId("new-thread").click();
  await send(page, "Session two, please.");
  await expect(page.getByTestId("agent-message").last()).toHaveText(/This is the second reply\./);

  await page.getByTestId("tab-Protocol").click();
  await expect(page.getByTestId("protocol-view").locator(".t-title").getByText("response new_session", { exact: true })).toBeVisible();

  // The launcher set EDUPI_CODING_AGENT_DIR, so the files are in the test home, laid out as ~/.pi/agent.
  const ws = realpathSync(join(E2E_DIR, "ws")); // /tmp is /private/tmp on macOS
  const dir = join(E2E_DIR, "home-edupi", "agent", "sessions", `--${ws.slice(1).replaceAll("/", "-")}--`);
  const files = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8"));
  const one = files.filter((f) => f.includes("Session one, please."));
  const two = files.filter((f) => f.includes("Session two, please."));
  expect(one).toHaveLength(1);
  expect(two).toHaveLength(1);
  expect(one[0]).not.toContain("Session two, please.");
  expect(JSON.parse(two[0].split("\n")[0])).toMatchObject({ type: "session", version: 3, cwd: ws });
});

test("the Requests tab shows an edupi request as Chat Completions messages", async ({ page }) => {
  await page.goto("/?backend=edupi");
  await expect(page.getByTestId("conn")).toHaveText("open");
  await send(page, "Say hello.");
  await expect(page.getByTestId("turn-sep")).toHaveCount(1);
  await send(page, "And again?");
  await expect(page.getByTestId("turn-sep")).toHaveCount(2);

  await page.getByTestId("tab-Requests").click();
  const view = page.getByTestId("requests-view");
  await expect(view).toContainText("POST https://openrouter.ai/api/v1/chat/completions");
  await expect(view).toContainText("unchanged ✓");
  const items = page.getByTestId("request-items");
  await expect(items).toHaveAttribute("data-api", "openai-completions");
  await expect(items).toContainText("Chat Completions messages");
  const rows = items.getByTestId("request-item");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("user");
  await expect(rows.nth(0)).toContainText("Say hello.");
  await expect(rows.nth(1)).toContainText("assistant");
  await expect(rows.nth(1)).toContainText("Hello from edupi.");
  await expect(rows.nth(2)).toContainText("And again?");
  await expect(view).toContainText("stopReason"); // the modelResponse trace event

  // The timeline lists edupi's trace events with their explanations.
  await page.getByTestId("tab-Timeline").click();
  await expect(page.locator('.t-row[data-event="modelRequest"]').first()).toContainText("Model request");
  await expect(page.locator('.t-row[data-event="modelResponse"]').first()).toContainText("Model response");
});

// The test entry "edupi-tools" runs backends/edupi/examples/faux/tools.json: write and bash in
// parallel, then an edit, then a text reply. The tools run for real in the viewer's directory.
test("edupi's tool calls show their output and the edit's diff, in the chat and in the Tools tab", async ({ page }) => {
  await page.goto("/?backend=edupi-tools");
  await expect(page.getByTestId("conn")).toHaveText("open");
  await send(page, "Write a greeting script, run a command, then change the greeting.");
  await expect(page.getByTestId("turn-sep")).toHaveCount(1);
  await expect(page.getByTestId("agent-message").last()).toHaveText(/changed the greeting/);

  // bash is a shell card with its output; write a generic tool card; edit a diff card.
  const command = page.getByTestId("command");
  await expect(command).toContainText("echo start; sleep 0.3; echo end");
  await expect(command.locator("pre.out")).toHaveText("start\nend\n");
  await expect(command).toContainText("completed");
  await expect(page.getByTestId("tool-call").filter({ has: page.locator(".badge", { hasText: "write" }) })).toContainText("Successfully wrote to edupi_greet.py");
  const edit = page.getByTestId("edit-diff");
  await expect(edit).toContainText("edupi_greet.py");
  await expect(edit).toContainText("Successfully replaced 1 block(s) in edupi_greet.py.");
  await expect(edit.locator(".diff .del")).toHaveText(["-2     print('hi')"]);
  await expect(edit.locator(".diff .add")).toHaveText(["+2     print('hello from edupi')"]);

  // The Tools tab: the specs the model got, then each call with its output.
  await page.getByTestId("tab-Tools").click();
  const tools = page.getByTestId("tools-view");
  for (const name of ["read", "bash", "edit", "write"]) await expect(tools.locator(".tool-spec summary").getByText(name, { exact: true })).toBeVisible();
  const calls = tools.getByTestId("tool-dispatch");
  await expect(calls).toHaveCount(3);
  await expect(calls.nth(0)).toContainText("write");
  await expect(calls.nth(0)).toContainText("parallel");
  await expect(calls.nth(1)).toContainText("bash");
  await expect(calls.nth(1)).toContainText("start\nend");
  await expect(calls.nth(2)).toContainText("edit");
  await expect(calls.nth(2)).toContainText("Successfully replaced 1 block(s)");

  // The timeline explains edupi's tool trace events.
  await page.getByTestId("tab-Timeline").click();
  await expect(page.locator('.t-row[data-event="toolDispatch"]').first()).toContainText("Tool call");
  await expect(page.locator('.t-row[data-event="toolOutput"]').first()).toContainText("Tool output");
});

// The test entry "edupi-queues" runs backends/edupi/examples/faux/queues.json: a bash call that
// takes 3 seconds, then a reply that thinks first, then a plain reply.
test("steer and follow up edupi while a command runs: pi's queues, drained after the tool", async ({ page }) => {
  await page.goto("/?backend=edupi-queues");
  await expect(page.getByTestId("conn")).toHaveText("open");
  await send(page, "Run a slow command.");
  const command = page.getByTestId("command");
  await expect(command).toContainText("running");

  // While the turn runs, the box stays open: steer goes in after the tool, follow-up when the agent would stop.
  await page.getByTestId("composer").fill("Use src/ instead.");
  await page.getByTestId("steer").click();
  await page.getByTestId("composer").fill("Then summarise.");
  await page.getByTestId("follow-up").click();
  await expect(page.getByTestId("queued")).toHaveText(["steer Use src/ instead.", "follow-up Then summarise."]);

  await expect(page.getByTestId("turn-sep")).toContainText("turn completed", { timeout: 15_000 });
  await expect(page.getByTestId("queue")).toHaveCount(0);
  await expect(command).toContainText("completed");
  // One turn: the queued messages come after the tool, in the order the model got them.
  await expect(page.locator(".msg.user .text")).toHaveText(["Run a slow command.", "Use src/ instead.", "Then summarise."]);
  await expect(page.locator(".reasoning")).toContainText("The user sent a new message while the command ran.");
  await expect(page.getByTestId("agent-message").last()).toHaveText(/Summary: the command printed started and finished\./);

  await page.getByTestId("tab-Protocol").click();
  const wire = page.getByTestId("protocol-view");
  for (const title of ["steer", "response steer", "follow_up", "response follow_up", "queue_update"])
    await expect(wire.locator(".t-title").getByText(title, { exact: true }).first()).toBeVisible();
});

test("abort edupi during a command: the command is killed and the turn ends as interrupted", async ({ page }) => {
  await page.goto("/?backend=edupi-queues");
  await expect(page.getByTestId("conn")).toHaveText("open");
  await send(page, "Run a slow command.");
  const command = page.getByTestId("command");
  await expect(command.locator("pre.out")).toHaveText(/started/);
  await page.getByTestId("interrupt").click();

  await expect(page.getByTestId("turn-sep")).toContainText("turn interrupted");
  await expect(command).toContainText("aborted");
  await expect(command.locator("pre.out")).toHaveText(/Command aborted/);
  await page.getByTestId("tab-Protocol").click();
  await expect(page.getByTestId("protocol-view").locator(".t-title").getByText("response abort", { exact: true })).toBeVisible();

  // The session goes on.
  await send(page, "Are you still there?");
  await expect(page.getByTestId("turn-sep")).toHaveCount(2);
  await expect(page.getByTestId("turn-sep").last()).toContainText("turn completed");
});

// The test entry "edupi-resume" starts edupi with --session on a file the real pi wrote. On connect
// the pi adapter asks for get_messages, so the viewer shows the conversation so far.
test("a session already in progress shows in the chat when the viewer connects", async ({ page }) => {
  await page.goto("/?backend=edupi-resume");
  await expect(page.getByTestId("conn")).toHaveText("open");
  await expect(page.locator(".msg.user .text")).toHaveText(["say hi", "run tools"]);
  await expect(page.getByTestId("agent-message")).toHaveText([/Hello from fake\./, /Done\./]);
  await expect(page.getByTestId("command")).toContainText("completed");
  await expect(page.getByTestId("turn-sep")).toHaveCount(2);

  // The session goes on in the same file: no new session was started.
  await send(page, "And now?");
  await expect(page.getByTestId("turn-sep")).toHaveCount(3);
  await page.getByTestId("tab-Protocol").click();
  const wire = page.getByTestId("protocol-view");
  await expect(wire.locator(".t-title").getByText("response get_messages", { exact: true })).toBeVisible();
  await expect(wire.locator(".t-title").getByText("response new_session", { exact: true })).toHaveCount(0);
});

test("a manual compaction with custom instructions shows in the chat and the timeline", async ({ page }) => {
  // pi keeps the last 20000 tokens by default, so this short chat would have nothing to compact.
  const home = join(E2E_DIR, "home-edupi-compact", "agent");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 10 } }));

  await page.goto("/?backend=edupi-compact");
  await expect(page.getByTestId("conn")).toHaveText("open");
  await send(page, "Say hello.");
  await expect(page.getByTestId("turn-sep")).toHaveCount(1);
  await send(page, "Say hello again.");
  await expect(page.getByTestId("turn-sep")).toHaveCount(2);

  // pi's /compact takes custom instructions after the command.
  await send(page, "/compact Keep the greetings.");
  await expect(page.getByTestId("compaction")).toHaveText("⟲ context compacted (manual)");
  await send(page, "Go on.");
  await expect(page.getByTestId("agent-message").last()).toHaveText(/This reply comes after the compaction\./);

  // The timeline: pi's compaction events, and edupi's trace events with the summary request and the new context.
  await page.getByTestId("tab-Timeline").click();
  await expect(page.locator('.t-row[data-event="compaction_start"]')).toContainText("manual");
  await expect(page.locator('.t-row[data-event="compactionRequest"]')).toHaveCount(2); // a split turn: history and turn prefix
  await expect(page.locator('.t-row[data-event="compactionRequest"]').first()).toContainText("Compaction request");
  await page.locator('.t-row[data-event="compacted"]').click();
  await expect(page.locator(".t-detail")).toContainText("Greet the user.");
  await expect(page.locator(".t-detail .links").getByRole("link", { name: /^pi: / })).toHaveAttribute("href",
    "https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/compaction/compaction.ts");
  await expect(page.locator('.t-row[data-event="compaction_end"]')).toContainText("tokens before");

  // The command went out as pi's compact command, with the instructions.
  await page.getByTestId("tab-Protocol").click();
  const wire = page.getByTestId("protocol-view");
  await wire.locator(".t-title").getByText("compact", { exact: true }).click();
  await expect(wire).toContainText('customInstructions: "Keep the greetings."');
});
