import { expect, test } from "@playwright/test";

async function openFixture(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByLabel("Access token").fill("e2e-token");
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByRole("button", { name: /codex-fixture.*\d+ 个对话/ }).click();
  await page.getByRole("button", { name: /^Question context fixture，/ }).click();
}

test("pins server question context without rendering the original user item", async ({ page }) => {
  await openFixture(page);
  const viewport = page.getByTestId("timeline-scroll");
  const answer = page.locator('[data-question-anchor="true"][data-anchor-item-id="agent-9"]');

  await expect(page.locator(".message-user", { hasText: "Follow-up instruction 10" })).toHaveCount(0);
  await answer.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await viewport.dispatchEvent("scroll");

  await expect(page.getByRole("button", { name: /原始问题：Follow-up instruction 10/ })).toBeVisible();
  expect(await viewport.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("updates the pinned question when reading an older answer and tool group", async ({ page }) => {
  await openFixture(page);
  const viewport = page.getByTestId("timeline-scroll");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const oldAnswer = page.locator('[data-anchor-item-id="agent-2"]');
  await oldAnswer.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await viewport.dispatchEvent("scroll");
  await expect(page.getByRole("button", { name: /原始问题：Follow-up instruction 3/ })).toBeVisible();

  const toolGroup = page.locator('.activity-group[data-anchor-item-id="history-reason"]');
  await toolGroup.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await viewport.dispatchEvent("scroll");
  await expect(page.getByRole("button", { name: /原始问题：Inspect the fixture/ })).toBeVisible();
  await toolGroup.locator("summary").click();
  await expect(toolGroup).toHaveAttribute("open", "");
  expect(errors).toEqual([]);
});

test("continues a long server question without a source user node", async ({ page }) => {
  await openFixture(page);
  const viewport = page.getByTestId("timeline-scroll");
  const answer = page.locator('[data-anchor-item-id="fixture-paginated-agent"]');

  await answer.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await viewport.dispatchEvent("scroll");
  const pinned = page.locator(".pinned-user-question");
  await expect(pinned).toBeVisible();
  await expect(pinned).not.toContainText("分页尾页");

  await pinned.click();
  await expect(pinned).toContainText("分页尾页");
  await expect(page.getByRole("button", { name: "继续展开原始问题" })).toHaveCount(0);
});
