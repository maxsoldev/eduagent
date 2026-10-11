import { expect, test, type Page } from "@playwright/test";

async function send(page: Page, text: string) {
  await expect(page.getByTestId("conn")).toHaveText("open");
  await page.getByTestId("composer").fill(text);
  await page.getByTestId("send").click();
}

test("a full turn: tools, approval, and every inspector tab", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("new-thread").click(); // fresh thread = fresh fake-model script
  await send(page, "Create hello.py that prints a greeting, then run it.");

  // The dangerous command pauses the turn with a server->client approval request.
  const approval = page.getByTestId("approval");
  await expect(approval).toContainText("rm -rf build");
  await expect(page.getByTestId("command").filter({ hasText: "python3 hello.py" })).toContainText("hello from educodex");
  await expect(page.getByTestId("file-change")).toContainText("hello.py");
  await page.getByTestId("approve-decline").click();

  await expect(page.getByTestId("turn-sep").last()).toContainText("turn completed");
  await expect(page.getByTestId("agent-message").last()).toContainText("Created `hello.py`");
  await expect(page.getByTestId("command").filter({ hasText: "rm -rf build" })).toContainText("declined");
  await expect(page.getByTestId("plan").last()).toContainText("Run it");

  // Tool cards fold away to their header and open again.
  const run = page.getByTestId("command").filter({ hasText: "python3 hello.py" });
  await run.locator(".card-head").click();
  await expect(run.locator(".card-head")).toHaveAttribute("aria-expanded", "false");
  await expect(run).not.toContainText("hello from educodex");
  await run.locator(".card-head").click();
  await expect(run).toContainText("hello from educodex");

  // Timeline shows the hidden steps.
  const timeline = page.getByTestId("timeline");
  await expect(timeline.locator(".t-row").last()).toBeInViewport();  // follows the newest event
  await timeline.evaluate((el) => el.scrollTo(0, 0));  // scrolling up stops following
  await page.getByTestId("timeline-to-latest").click();
  await expect(timeline.locator(".t-row").last()).toBeInViewport();
  await expect(page.getByTestId("timeline-to-latest")).toHaveCount(0);
  for (const title of ["Prompt assembled", "Model request", "Loop decision", "Policy decision", "Sandboxed command", "Approval requested"]) {
    await expect(timeline.getByText(title, { exact: true }).first()).toBeVisible();
  }
  await timeline.getByText("Model request", { exact: true }).first().click();
  await expect(page.locator(".explain").first()).toContainText("store=false");

  // Context: the exact next request, labelled by source.
  await page.getByTestId("tab-Context").click();
  const items = page.getByTestId("ctx-item");
  await expect(items.last()).toBeInViewport();  // the list starts at the newest item
  await expect(page.getByTestId("ctx-to-latest")).toHaveCount(0);
  await expect(items.first()).toContainText("base instructions");
  await expect(items.nth(1)).toContainText("permissions");
  await expect(page.getByTestId("context-view")).toContainText("tool output");
  await items.nth(1).locator(".t-head").click();  // expanded parts show their content type
  await expect(page.getByTestId("ctx-part").first()).toContainText("part 1 · type: input_text");
  // Breakdown by category, and a tooltip on each bar segment.
  await expect(page.getByTestId("ctx-breakdown")).toContainText("tool definitions");
  await expect(page.getByTestId("ctx-breakdown")).toContainText("tool outputs");
  await expect(page.getByTestId("ctx-breakdown")).toContainText("next cost");
  await page.getByTestId("breakdown-toggle").click();  // folds to a one-line summary
  await expect(page.getByTestId("cat-row")).toHaveCount(0);
  await expect(page.getByTestId("ctx-breakdown")).toContainText("to resend");
  await page.getByTestId("breakdown-toggle").click();
  await page.getByTestId("ctx-seg").nth(1).hover();
  await expect(page.getByTestId("ctx-tip")).toContainText("base instructions");
  await expect(page.getByTestId("ctx-tip")).toContainText("of context");

  // Requests: each request extends the previous one (prompt-cache friendly).
  await expect(page.getByTestId("context-cost")).toContainText("Read from cache");
  await expect(page.getByTestId("context-cost")).toContainText("where the money goes");
  await page.getByTestId("cost-toggle").click();  // the cost panel folds to a one-line summary
  await expect(page.getByTestId("context-cost")).not.toContainText("where the money goes");
  await expect(page.getByTestId("context-cost")).toContainText("session $");
  await page.getByTestId("cost-toggle").click();
  await expect(page.locator(".cache-tag.cached").first()).toBeVisible();

  await page.getByTestId("tab-Requests").click();
  await expect(page.getByTestId("requests-view")).toContainText("unchanged ✓");
  // JSON tree: the key opens one level, the arrow opens everything below.
  const reasoning = page.getByTestId("requests-view").locator(".j-key.clickable", { hasText: /^reasoning: $/ }).first().locator("..");
  await reasoning.locator("> .j-key").click();
  await expect(reasoning.locator(".j-key", { hasText: "effort" })).toBeVisible();
  const input = page.getByTestId("requests-view").locator(".j-key.clickable", { hasText: /^input: $/ }).first().locator("..");
  await input.locator("> .j-key").click();
  await expect(input.locator(".j-key", { hasText: /^role: $/ })).toHaveCount(0);
  await input.locator("> .j-key").click(); // collapse, then expand all with the arrow
  await input.locator("> .j-toggle").click();
  await expect(input.locator(".j-key", { hasText: /^role: $/ }).first()).toBeVisible();
  await expect(input.locator(".j-key", { hasText: /^text: $/ }).first()).toBeVisible();
  await expect(page.getByTestId("cost-table")).toContainText("read from cache");
  await expect(page.getByTestId("cost-table")).toContainText("caching saved");
  await expect(page.getByTestId("cost-badge")).toContainText("cached");

  await page.getByTestId("tab-Tools").click();
  await expect(page.getByTestId("tools-view")).toContainText("apply_patch");

  await page.getByTestId("tab-Guardrails").click();
  await expect(page.getByTestId("guardrails-view")).toContainText("dangerous command");

  await page.getByTestId("tab-Protocol").click();
  await expect(page.getByTestId("protocol-view")).toContainText("item/commandExecution/requestApproval");

  // A new thread starts its per-thread tabs empty; the timeline keeps old events, dimmed.
  await page.getByTestId("new-thread").click();
  await page.getByTestId("tab-Requests").click();
  await expect(page.getByText("No model requests yet.")).toBeVisible();
  await page.getByTestId("tab-Guardrails").click();
  await expect(page.getByText("No tool has run yet.", { exact: false })).toBeVisible();
  await page.getByTestId("tab-Timeline").click();
  await expect(page.locator(".t-row.other-thread").first()).toBeAttached();
});

test("step mode pauses before each model call", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("step-mode").check();
  await page.getByTestId("new-thread").click();
  await page.getByTestId("step-mode").check();
  await send(page, "go");
  const paused = page.getByTestId("paused");
  await expect(paused).toContainText("beforeModelRequest");
  // Step through: each Continue releases one breakpoint.
  for (let i = 0; i < 40; i++) {
    if (await page.getByTestId("approval").isVisible()) await page.getByTestId("approve-decline").click();
    if (await page.getByTestId("turn-sep").count()) break;
    if (await paused.isVisible()) await page.getByTestId("continue").click();
    await page.waitForTimeout(150);
  }
  await expect(page.getByTestId("turn-sep").last()).toContainText("turn completed");
});
