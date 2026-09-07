import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { expect, test } from "@playwright/test";

test("fits a real assistant image to the conversation and previews the uncropped original", async ({ page }) => {
  const fixture = await build({
    stdin: {
      resolveDir: process.cwd(), loader: "tsx",
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { Timeline } from "./src/web/components/timeline";
        import { hydrateThread } from "./src/web/state/conversation-history";
        import { initialCodexState } from "./src/protocol/thread-store";
        const thread = hydrateThread(initialCodexState, { thread: { id: "fixture", turns: [{
          id: "turn", status: "completed", items: [
            { id: "assistant", type: "agentMessage", text: "![App icon](/fixture/app-icon.png)",
              localImages: { "/fixture/app-icon.png": "00000000-0000-4000-8000-000000000001" } },
            { id: "user", type: "userMessage", text: "Existing user attachment", imageIds: ["00000000-0000-4000-8000-000000000001"] }
          ]
        }] } }).threads.fixture;
        createRoot(document.getElementById("root")).render(
          <div className="timeline-scroll" style={{ height: "100vh" }}><Timeline thread={thread} /></div>
        );`,
    },
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"test"' },
  });
  await page.route("**/__image-layout", (route) => route.fulfill({
    contentType: "text/html", body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>',
  }));
  await page.route("**/api/images/00000000-0000-4000-8000-000000000001", (route) => route.fulfill({
    contentType: "image/png", body: readFileSync(resolve("assets/app-icon.png")),
  }));
  await page.goto("/__image-layout");
  await page.addStyleTag({ path: resolve("src/web/styles.css") });
  await page.addScriptTag({ content: fixture.outputFiles[0].text });
  const image = page.locator(".message-agent .message-image-link img");
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1024);
  const geometry = await image.evaluate((element: HTMLImageElement) => {
    const image = element.getBoundingClientRect();
    const parent = element.closest(".markdown-body")!.getBoundingClientRect();
    const button = element.parentElement!.getBoundingClientRect();
    return { width: image.width, height: image.height, right: image.right, parentRight: parent.right,
      parentWidth: parent.width, buttonWidth: button.width, viewport: innerWidth };
  });
  expect(geometry.width).toBeLessThanOrEqual(geometry.parentWidth);
  expect(geometry.buttonWidth).toBeLessThanOrEqual(geometry.parentWidth);
  expect(geometry.right).toBeLessThanOrEqual(geometry.parentRight);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.width / geometry.height).toBeCloseTo(1, 2);
  await page.getByRole("button", { name: "预览App icon" }).click();
  const preview = page.getByRole("dialog").locator("img");
  await expect(preview).toBeVisible();
  const fullImage = await preview.evaluate((element: HTMLImageElement) => ({
    width: element.naturalWidth, height: element.naturalHeight,
    box: { width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height },
    bounds: { left: element.getBoundingClientRect().left, top: element.getBoundingClientRect().top,
      right: element.getBoundingClientRect().right, bottom: element.getBoundingClientRect().bottom },
    viewport: { width: innerWidth, height: innerHeight },
    fit: getComputedStyle(element).objectFit,
  }));
  expect(fullImage.width).toBe(1024);
  expect(fullImage.height).toBe(1024);
  expect(fullImage.box.width / fullImage.box.height).toBeCloseTo(1, 2);
  expect(fullImage.fit).toBe("contain");
  expect(fullImage.bounds.left).toBeGreaterThanOrEqual(0);
  expect(fullImage.bounds.top).toBeGreaterThanOrEqual(0);
  expect(fullImage.bounds.right).toBeLessThanOrEqual(fullImage.viewport.width);
  expect(fullImage.bounds.bottom).toBeLessThanOrEqual(fullImage.viewport.height);
  await page.getByRole("button", { name: "关闭图片预览" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
