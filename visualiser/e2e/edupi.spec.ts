import { expect, test, type Page } from "@playwright/test";

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
