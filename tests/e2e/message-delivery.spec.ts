import { expect, test } from "@playwright/test";

test("accepts immediately and continues sending after the client reloads", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Access token").fill("e2e-token");
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByRole("button", { name: /codex-fixture.*\d+ 个对话/ }).click();
  await page.getByRole("button", { name: /^Fixture task，/ }).click();
  const input = page.getByRole("textbox", { name: "Instruction" });
  await input.fill("Async delivery regression");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("服务端已接收，正在发送…")).toBeVisible();
  await expect(input).toHaveValue("");
  await expect(input).toBeEnabled();
  await page.reload();
  await expect(page.getByText("服务端已接收，正在发送…")).toBeVisible();
  await expect(page.getByTestId("timeline-scroll")).toContainText("Async delivery regression", { timeout: 10_000 });
  await expect(page.getByText("服务端已接收，正在发送…")).toHaveCount(0);
  await expect(page.locator(".message-user").filter({ hasText: "Async delivery regression" })).toHaveCount(1);
  const stop = page.getByRole("button", { name: "Stop" });
  if (await stop.count()) await stop.click();
});
