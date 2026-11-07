import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { expect, test } from "@playwright/test";

test("the remote app displays an attachment when image HTTP GET never responds", async ({ page }) => {
  const fixture = await build({
    stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { App } from "./src/web/app";
      createRoot(document.getElementById("root")).render(<App remote={{
        connectionId: "test", name: "QA", baseUrl: location.origin, token: "e2e-token",
        requestedThreadId: "fixture-thread", uploadImagesViaSocket: true,
        onManageConnections() {}
      }} />);
    ` },
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"test"', "import.meta.url": "location.href" },
  });
  let httpImageReads = 0;
  await page.route("**/api/images/*", () => { httpImageReads++; });
  await page.route("**/__chat-image", route => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>',
  }));
  await page.goto("/__chat-image");
  await page.addStyleTag({ path: "src/web/styles.css" });
  await page.addScriptTag({ content: fixture.outputFiles[0].text });
  await page.getByRole("textbox", { name: "Instruction" }).click();
  await page.getByLabel("添加图片").setInputFiles({
    name: "photo.png", mimeType: "image/png", buffer: readFileSync("assets/app-icon.png"),
  });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const image = page.getByRole("img", { name: "用户上传的图片 1", exact: true }).last();
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  expect(httpImageReads).toBe(0);
});
