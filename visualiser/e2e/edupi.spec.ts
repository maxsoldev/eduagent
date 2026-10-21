import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
	await expect(page.getByTestId("agent-message").last()).toHaveText(
		/Hello from edupi\. This reply comes from the faux provider/,
	);
	await expect(page.getByTestId("turn-sep").last()).toContainText("turn completed");

	await send(page, "And again?");
	await expect(page.getByTestId("turn-sep")).toHaveCount(2);
	await expect(page.getByTestId("agent-message").last()).toHaveText(/This is the second reply\./);

	// The reply came as pi's streaming events: text deltas between message_start and message_end.
	await page.getByTestId("tab-Protocol").click();
	const wire = page.getByTestId("protocol-view");
	await expect(wire).toContainText("pi RPC");
	for (const title of [
		"get_state",
		"prompt",
		"response prompt",
		"agent_start",
		"message_update",
		"message_end",
		"agent_settled",
	])
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
	await expect(
		page.getByTestId("protocol-view").locator(".t-title").getByText("response new_session", { exact: true }),
	).toBeVisible();

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
	await expect(rows).toHaveCount(4);
	await expect(rows.nth(0)).toContainText("system"); // pi's prompt, replayed at the head of every request
	await expect(rows.nth(0)).toContainText("You are an expert coding assistant operating inside pi");
	await expect(rows.nth(1)).toContainText("user");
	await expect(rows.nth(1)).toContainText("Say hello.");
	await expect(rows.nth(2)).toContainText("assistant");
	await expect(rows.nth(2)).toContainText("Hello from edupi.");
	await expect(rows.nth(3)).toContainText("And again?");
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
	await expect(
		page.getByTestId("tool-call").filter({ has: page.locator(".badge", { hasText: "write" }) }),
	).toContainText("Successfully wrote to edupi_greet.py");
	const edit = page.getByTestId("edit-diff");
	await expect(edit).toContainText("edupi_greet.py");
	await expect(edit).toContainText("Successfully replaced 1 block(s) in edupi_greet.py.");
	await expect(edit.locator(".diff .del")).toHaveText(["-2     print('hi')"]);
	await expect(edit.locator(".diff .add")).toHaveText(["+2     print('hello from edupi')"]);

	// The Tools tab: the specs the model got, then each call with its output.
	await page.getByTestId("tab-Tools").click();
	const tools = page.getByTestId("tools-view");
	for (const name of ["read", "bash", "edit", "write"])
		await expect(tools.locator(".tool-spec summary").getByText(name, { exact: true })).toBeVisible();
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

/** Writes a file, making its folders. */
function put(path: string, text: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

// The test entry "edupi-skills" runs with --approve (the project's .pi folder is trusted) and
// backends/edupi/examples/faux/skills.json: the model reads .pi/skills/greet/SKILL.md, then answers.
test("the Context tab shows the parts of edupi's prompt: pi's sections, AGENTS.md and the skills list", async ({
	page,
}) => {
	const ws = join(E2E_DIR, "ws-skills");
	put(join(ws, "AGENTS.md"), "Answer in plain English.");
	put(
		join(ws, ".pi", "skills", "greet", "SKILL.md"),
		"---\nname: greet\ndescription: Greets the user warmly.\n---\n\nSay hello and name the skill.\n",
	);
	put(
		join(E2E_DIR, "home-edupi-skills", "agent", "skills", "release", "SKILL.md"),
		"---\nname: release\ndescription: Cuts a release.\ndisable-model-invocation: true\n---\n\nTag and push.\n",
	);

	await page.goto(`/?backend=edupi-skills&cwd=${encodeURIComponent(ws)}`);
	await expect(page.getByTestId("conn")).toHaveText("open");
	await send(page, "Please greet me.");
	await expect(page.getByTestId("turn-sep")).toHaveCount(1);
	await expect(page.getByTestId("agent-message").last()).toHaveText(/I followed the greet skill/);
	// The lazy load: the model read the skill's file with pi's read tool.
	await expect(
		page.getByTestId("tool-call").filter({ has: page.locator(".badge", { hasText: "read" }) }),
	).toContainText("Say hello and name the skill.");

	await page.getByTestId("tab-Context").click();
	const items = page.getByTestId("ctx-item");
	await expect(items.first()).toContainText("system prompt");
	await expect(page.getByTestId("context-view")).toContainText("tool output: SKILL.md");
	await items.first().locator(".t-head").click();
	const parts = page.getByTestId("ctx-part");
	await expect(parts.locator(".part-head code")).toHaveText([
		"preamble",
		"tools",
		"rules",
		"project_context",
		"skills",
		"cwd",
	]);
	await expect(parts.nth(3)).toContainText("Answer in plain English.");
	await expect(parts.nth(3)).toContainText(join(realpathSync(ws), "AGENTS.md"));
	await expect(parts.nth(4)).toContainText("<name>greet</name>");
	await expect(parts.nth(4)).not.toContainText("release"); // opted out of model use
	await expect(page.getByTestId("ctx-breakdown")).toContainText("tool definitions");

	// "$" lists the skills from pi's get_commands, also the one hidden from the model.
	await page.getByTestId("composer").fill("use $");
	await expect(page.getByTestId("skill-popup")).toContainText("$greet");
	await expect(page.getByTestId("skill-popup")).toContainText("$release");
	await page.getByTestId("composer").fill("");

	// The timeline explains the two trace events.
	await page.getByTestId("tab-Timeline").click();
	await expect(page.locator('.t-row[data-event="skillsLoaded"]').first()).toContainText("Skills loaded");
	await expect(page.locator('.t-row[data-event="skillsLoaded"]').first()).toContainText("2 skills");
	await expect(page.locator('.t-row[data-event="promptAssembled"]').first()).toContainText("Prompt assembled");
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
	await expect(page.locator(".msg.user .text")).toHaveText([
		"Run a slow command.",
		"Use src/ instead.",
		"Then summarise.",
	]);
	await expect(page.locator(".reasoning")).toContainText("The user sent a new message while the command ran.");
	await expect(page.getByTestId("agent-message").last()).toHaveText(
		/Summary: the command printed started and finished\./,
	);

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
	await expect(
		page.getByTestId("protocol-view").locator(".t-title").getByText("response abort", { exact: true }),
	).toBeVisible();

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
	await expect(page.locator(".t-detail .links").getByRole("link", { name: /^pi: / })).toHaveAttribute(
		"href",
		"https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/compaction/compaction.ts",
	);
	await expect(page.locator('.t-row[data-event="compaction_end"]')).toContainText("tokens before");

	// The command went out as pi's compact command, with the instructions.
	await page.getByTestId("tab-Protocol").click();
	const wire = page.getByTestId("protocol-view");
	await wire.locator(".t-title").getByText("compact", { exact: true }).click();
	await expect(wire).toContainText('customInstructions: "Keep the greetings."');
});

// The test entry "edupi-step" runs backends/edupi/examples/faux/step.json: OpenRouter's list
// prices the model (200k context window), the model runs one bash command, then answers.
test("step mode, the Context tab, the context bar and the cost panel work for edupi", async ({ page }) => {
	await page.goto("/?backend=edupi-step");
	await expect(page.getByTestId("conn")).toHaveText("open");
	await page.getByTestId("step-mode").check();
	await send(page, "Run a command.");

	// Paused before the first model request: the Context tab shows that request, from debug_get_context.
	const paused = page.getByTestId("paused");
	await expect(paused).toContainText("beforeModelRequest");
	await page.getByTestId("tab-Context").click();
	const items = page.getByTestId("ctx-item");
	await expect(items.first()).toContainText("system prompt");
	await expect(items.last()).toContainText("user");
	// pi's threshold: the model's context window minus pi's reserve (16384 tokens).
	await expect(page.getByTestId("context-view")).toContainText(
		"of 200,000 tokens (estimate) · auto-compact at 183,616",
	);

	// Step through: before the tool call, after it, before the second request.
	const seen: string[] = [];
	const where = async () => ((await paused.count()) ? await paused.locator("code").textContent() : null);
	for (let i = 0; i < 10 && !(await page.getByTestId("turn-sep").count()); i++) {
		const at = await where();
		if (at) {
			seen.push(at);
			await page.getByTestId("continue").click();
			await expect.poll(where).not.toBe(at); // the next pause, or none (no two pauses in a row at the same point here)
		}
		await page.waitForTimeout(100);
	}
	await expect(page.getByTestId("turn-sep").last()).toContainText("turn completed");
	expect(seen).toEqual(["beforeModelRequest", "beforeToolCall", "afterToolCall", "beforeModelRequest"]);
	await expect(page.getByTestId("agent-message").last()).toContainText("The command printed a greeting.");

	// The context now ends with the reply; the bar and the breakdown show its parts and their cost.
	await expect(items.last()).toContainText("assistant");
	await expect(page.getByTestId("context-view")).toContainText("tool output");
	await expect(page.getByTestId("ctx-breakdown")).toContainText("tool definitions");
	await expect(page.getByTestId("ctx-breakdown")).toContainText("next cost");
	await page.getByTestId("ctx-seg").nth(1).hover();
	await expect(page.getByTestId("ctx-tip")).toContainText("system prompt");

	// Cost: pi priced each response with OpenRouter's prices; the panel and the header badge show it.
	const cost = page.getByTestId("context-cost");
	await expect(cost).toContainText("Read from cache");
	await expect(cost).toContainText("where the money goes");
	await expect(cost).toContainText("$1/M"); // uncached input, from the model list
	await expect(cost).toContainText("2 requests");
	await expect(page.getByTestId("cost-badge")).toContainText("$");

	await page.getByTestId("tab-Requests").click();
	await expect(page.getByTestId("cost-table").first()).toBeVisible();
});
