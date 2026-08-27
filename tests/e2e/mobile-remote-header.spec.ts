import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const styles = readFileSync("src/web/styles.css", "utf8");

test.describe("native mobile remote header", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chrome-mobile", "mobile layout only");
    await page.goto("about:blank");
    await page.setContent(`
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>${styles}</style>
      <main class="app-root">
        <header class="topbar topbar-native">
          <div class="brand-lockup">
            <h1><button type="button" class="mobile-remote-home">Remote</button></h1>
          </div>
          <nav class="remote-connection-switcher" aria-label="连接">
            <button type="button" class="manage-connections-button remote-connection-pill is-active">
              <span class="remote-connection-indicator connection-ready"></span>
              <span>Codex Remote Office Mac</span>
            </button>
          </nav>
          <div class="connection-state connection-ready"><span></span>Connected</div>
        </header>
      </main>
    `);
    await expect(page.locator(".topbar-native")).toHaveCSS("display", "flex");
  });

  test("anchors connection names on the right without covering Remote", async ({ page }) => {
    const remote = page.getByRole("button", { name: "Remote", exact: true });
    const switcher = page.getByRole("navigation", { name: "连接" });
    const connection = switcher.getByRole("button");
    const [remoteBox, switcherBox, connectionBox] = await Promise.all([
      remote.boundingBox(),
      switcher.boundingBox(),
      connection.boundingBox(),
    ]);

    expect(remoteBox).not.toBeNull();
    expect(switcherBox).not.toBeNull();
    expect(connectionBox).not.toBeNull();
    expect(switcherBox!.x).toBeGreaterThanOrEqual(remoteBox!.x + remoteBox!.width + 10);
    expect(connectionBox!.x + connectionBox!.width).toBeCloseTo(
      switcherBox!.x + switcherBox!.width,
      0,
    );
  });

  test("scrolls horizontally when connection names exceed the reserved space", async ({ page }) => {
    const switcher = page.getByRole("navigation", { name: "连接" });
    await switcher.evaluate((element) => {
      for (let index = 2; index <= 5; index += 1) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "manage-connections-button remote-connection-pill";
        button.textContent = `Remote connection ${index}`;
        element.append(button);
      }
    });

    const before = await switcher.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      scrollLeft: element.scrollLeft,
    }));
    expect(before.scrollWidth).toBeGreaterThan(before.clientWidth);

    const after = await switcher.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
      return element.scrollLeft;
    });
    expect(after).toBeGreaterThan(before.scrollLeft);
  });
});
