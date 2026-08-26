import { expect, test } from "@playwright/test";

test.describe("native mobile settings preview", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?mobile-shell-preview=1");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  test("changes theme language and message delivery and keeps them after reload", async ({ page }) => {
    await page.getByRole("button", { name: "设置" }).click();
    await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();

    await page.getByRole("radio", { name: "暗色" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("radio", { name: "English" }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await page.getByRole("radio", { name: /Steer/ }).click();

    await page.reload();
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();
    await expect(page.getByRole("radio", { name: "English" })).toBeChecked();
    await expect(page.getByRole("radio", { name: /Steer/ })).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");

    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByRole("heading", { name: "Choose a Mac" })).toBeVisible();
  });

  test("keeps settings and update controls balanced and clickable", async ({ page }) => {
    const settings = page.getByRole("button", { name: "设置" });
    const update = page.getByRole("button", { name: "检查更新" });
    const [settingsBox, updateBox] = await Promise.all([settings.boundingBox(), update.boundingBox()]);

    expect(settingsBox).not.toBeNull();
    expect(updateBox).not.toBeNull();
    expect(settingsBox!.width).toBeCloseTo(updateBox!.width, 0);
    expect(settingsBox!.height).toBeCloseTo(updateBox!.height, 0);
    expect(settingsBox!.width).toBeCloseTo(48, 0);
    expect(updateBox!.height).toBeCloseTo(48, 0);

    await update.click();
    await settings.click();
    await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
  });
});
