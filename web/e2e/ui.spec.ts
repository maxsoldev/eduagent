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

  // Timeline shows the hidden steps.
  const timeline = page.getByTestId("timeline");
  for (const title of ["Prompt assembled", "Model request", "Loop decision", "Policy decision", "Sandboxed command", "Approval requested"]) {
    await expect(timeline.getByText(title, { exact: true }).first()).toBeVisible();
  }
  await timeline.getByText("Model request", { exact: true }).first().click();
  await expect(page.locator(".explain").first()).toContainText("store=false");

  // Context: the exact next request, labelled by source.
  await page.getByTestId("tab-Context").click();
  const items = page.getByTestId("ctx-item");
  await expect(items.first()).toContainText("base instructions");
  await expect(items.nth(1)).toContainText("permissions");
  await expect(page.getByTestId("context-view")).toContainText("tool output");

  // Requests: each request extends the previous one (prompt-cache friendly).
  await page.getByTestId("tab-Requests").click();
  await expect(page.getByTestId("requests-view")).toContainText("unchanged ✓");

  await page.getByTestId("tab-Tools").click();
  await expect(page.getByTestId("tools-view")).toContainText("apply_patch");

  await page.getByTestId("tab-Guardrails").click();
  await expect(page.getByTestId("guardrails-view")).toContainText("dangerous command");

  await page.getByTestId("tab-Protocol").click();
  await expect(page.getByTestId("protocol-view")).toContainText("item/commandExecution/requestApproval");
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
