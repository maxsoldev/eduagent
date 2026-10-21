import { expect, test, type Page } from "@playwright/test";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
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
