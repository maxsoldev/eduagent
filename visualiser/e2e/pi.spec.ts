import { expect, type Page, test } from "@playwright/test";

// A pi viewer through the launcher. CI has no real pi, so the test entry "pi-replay" replays the
// transcript recorded from the real pi (visualiser/test/fixtures/pi/chat.out.jsonl) in answer to
// the viewer's pi RPC commands. It is listed like the real pi entry: chat only, no trace.

async function send(page: Page, text: string) {
	await page.getByTestId("composer").fill(text);
	await page.getByTestId("send").click();
}

test("chat with pi: a reply, parallel tools, no trace panels, native messages", async ({ page }) => {
	await page.goto("/?backend=pi-replay");
	await expect(page.getByTestId("conn")).toHaveText("open");
	await expect(page.locator(".brand")).toContainText("inside pi");

	await send(page, "Say hello.");
	await expect(page.getByTestId("agent-message").last()).toHaveText(/Hello from the fake model\./);
	await expect(page.getByTestId("turn-sep").last()).toContainText("turn completed");

	await send(page, "Run echo hi, then read a.txt and missing.txt.");
	await expect(page.getByTestId("turn-sep")).toHaveCount(2);
	await expect(page.getByTestId("command").filter({ hasText: "echo hi" })).toContainText("completed");
	await expect(page.getByTestId("tool-call").filter({ hasText: "a.txt" }).first()).toContainText("alpha");
	await expect(page.getByTestId("tool-call").filter({ hasText: "missing.txt" })).toContainText("failed");
	await expect(page.getByTestId("agent-message").last()).toContainText("missing.txt does not exist");

	// Only the native tabs: real pi sends no trace events and has no context inspector.
	for (const tab of ["Context", "Requests", "Tools", "Guardrails"])
		await expect(page.getByTestId(`tab-${tab}`)).toHaveCount(0);
	for (const id of ["approval-policy", "sandbox", "step-mode", "cost-badge"])
		await expect(page.getByTestId(id)).toHaveCount(0);
	await expect(page.getByTestId("compact")).toBeVisible();

	// Timeline links point to pi's source at the pinned commit.
	const timeline = page.getByTestId("timeline");
	await timeline.getByText("Tool call", { exact: true }).first().click();
	await expect(page.locator(".t-detail .links").first().getByRole("link", { name: /^pi: / })).toHaveAttribute(
		"href",
		"https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/agent/src/agent-loop.ts",
	);

	// The Protocol tab shows pi's own messages, both ways.
	await page.getByTestId("tab-Protocol").click();
	const wire = page.getByTestId("protocol-view");
	await expect(wire).toContainText("pi RPC");
	for (const title of ["get_state", "prompt", "response prompt", "agent_start", "tool_execution_end", "agent_settled"])
		await expect(wire.locator(".t-title").getByText(title, { exact: true }).first()).toBeVisible();
});
