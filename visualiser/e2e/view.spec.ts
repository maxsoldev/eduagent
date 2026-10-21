import { expect, test } from "@playwright/test";

// The viewer adapts to the backend entry: its capabilities choose the panels, its harness the source links.

test("a backend entry without capabilities hides their panels", async ({ page }) => {
  await page.goto("/?backend=educodex-plain"); // educodex, listed with "capabilities": []
  await expect(page.getByTestId("conn")).toHaveText("open");

  // No approvals, sandbox, step mode or compaction controls.
  for (const id of ["approval-policy", "sandbox", "step-mode", "compact"]) await expect(page.getByTestId(id)).toHaveCount(0);
  // Without trace events or the context inspector only the native protocol tabs stay.
  for (const tab of ["Context", "Requests", "Tools", "Guardrails"]) await expect(page.getByTestId(`tab-${tab}`)).toHaveCount(0);
  await expect(page.getByTestId("tab-Timeline")).toBeVisible();
  await expect(page.getByTestId("tab-Protocol")).toBeVisible();
  // Slash commands for missing features (skills, compaction, memories) are not offered.
  await page.getByTestId("composer").fill("/");
  await expect(page.getByTestId("command-popup").locator(".popup-name")).toHaveText(["/new"]);
  await page.getByTestId("composer").fill("use $skill");
  await expect(page.getByTestId("skill-popup")).toHaveCount(0);

  // The chat still works through the same view.
  await page.getByTestId("composer").fill("Create hello.py that prints a greeting, then run it.");
  await page.getByTestId("send").click();
  await expect(page.getByTestId("turn-sep").last()).toContainText("turn completed");
  await expect(page.getByTestId("command").filter({ hasText: "python3 hello.py" })).toContainText("hello from educodex");
  await expect(page.getByTestId("approval")).toHaveCount(0);
  await expect(page.getByTestId("cost-badge")).toHaveCount(0);
  await expect(page.getByTestId("paused")).toHaveCount(0);

  // The Protocol tab shows the native messages.
  await page.getByTestId("tab-Protocol").click();
  await expect(page.getByTestId("protocol-view")).toContainText("turn/start");
});

test("timeline links point to the connected backend's harness, commit and guide", async ({ page }) => {
  await page.goto("/?backend=educodex");
  await expect(page.getByTestId("conn")).toHaveText("open");
  await page.getByTestId("composer").fill("Create hello.py that prints a greeting, then run it.");
  await page.getByTestId("send").click();
  await page.getByTestId("approve-decline").click();
  await expect(page.getByTestId("turn-sep").last()).toContainText("turn completed");

  await page.getByTestId("timeline").getByText("Model request", { exact: true }).first().click();
  const links = page.locator(".t-detail .links").first();
  await expect(links.getByRole("link", { name: "guide ch.02" })).toHaveAttribute("href", "/guide/educodex/02");
  await expect(links.getByRole("link", { name: /^Codex: / })).toHaveAttribute("href",
    "https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/client.rs");
});
