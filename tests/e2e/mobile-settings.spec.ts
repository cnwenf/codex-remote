import { expect, test } from "@playwright/test";

test.describe("native mobile settings preview", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?mobile-shell-preview=1");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  test("changes theme and language while keeping safe queued delivery after reload", async ({ page }) => {
    await page.getByRole("button", { name: "设置" }).click();
    await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();

    await page.getByRole("radio", { name: "暗色" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("radio", { name: "English" }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page.getByRole("radio", { name: /Queue/ })).toBeChecked();
    await expect(page.getByRole("radio", { name: /Steer/ })).toHaveCount(0);

    await page.reload();
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();
    await expect(page.getByRole("radio", { name: "English" })).toBeChecked();
    await expect(page.getByRole("radio", { name: /Queue/ })).toBeChecked();
    await expect(page.getByRole("radio", { name: /Steer/ })).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");

    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByRole("heading", { name: "Choose a Mac" })).toBeVisible();
  });

  test("keeps settings and update controls large enough to tap", async ({ page }) => {
    const settings = page.getByRole("button", { name: "设置" });
    const settingsBox = await settings.boundingBox();

    await settings.click();
    const update = page.getByRole("button", { name: "检查更新" });
    await update.scrollIntoViewIfNeeded();
    const updateBox = await update.boundingBox();

    expect(settingsBox).not.toBeNull();
    expect(updateBox).not.toBeNull();
    expect(settingsBox!.width).toBeCloseTo(48, 0);
    expect(settingsBox!.height).toBeCloseTo(48, 0);
    expect(updateBox!.height).toBeGreaterThanOrEqual(42);

    await update.click();
    await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
  });

  test("keeps software update reachable inside the settings scroll area", async ({ page }) => {
    await page.getByRole("button", { name: "设置" }).click();

    const settingsPage = page.locator(".mobile-settings");
    const scrollArea = await settingsPage.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      viewportHeight: window.innerHeight,
    }));

    expect(scrollArea.clientHeight).toBeLessThanOrEqual(scrollArea.viewportHeight);
    expect(scrollArea.scrollHeight).toBeGreaterThan(scrollArea.clientHeight);

    const checkUpdate = page.getByRole("button", { name: "检查更新" });
    await checkUpdate.scrollIntoViewIfNeeded();
    await expect(checkUpdate).toBeInViewport();
    await checkUpdate.click();
  });

  test("starts on the connection list and marks an unreachable saved connection without opening it", async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem("CapacitorStorage.codex-remote.connections.v1", JSON.stringify([{
        id: "offline-mac",
        name: "Offline Mac",
        baseUrl: "http://127.0.0.1:4999",
        lastUsedAt: 1,
        pairingStatus: "ready",
      }]));
      localStorage.setItem("CapacitorStorage.codex-remote.selected.v1", "offline-mac");
    });
    await page.reload();

    await expect(page.getByRole("heading", { name: "选择一台 Mac" })).toBeVisible();
    await expect(page.getByLabel("不可用")).toBeVisible();
    await expect(page.getByText(/无法连接 Offline Mac/)).toHaveCount(0);
  });
});
