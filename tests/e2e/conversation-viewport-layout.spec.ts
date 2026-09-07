import { resolve } from "node:path";
import { build } from "esbuild";
import { expect, test } from "@playwright/test";

test("keeps the pinned question out of the conversation flow while paging upward", async ({ page }) => {
  const fixture = await build({
    stdin: {
      resolveDir: process.cwd(), loader: "tsx",
      contents: `
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { ConversationViewport } from "./src/web/components/conversation-viewport";
        const question = "A long original question that stays available while reading the final answer.";
        function Fixture() {
          const [currentQuestion, setCurrentQuestion] = useState();
          window.enablePinnedQuestion = () => setCurrentQuestion(question);
          return <main data-current-question={currentQuestion ?? ""} style={{ height: "640px", display: "flex", flexDirection: "column" }}>
              <ConversationViewport threadId="fixture" currentQuestion={currentQuestion}
                history={{ hasMoreBefore: false, loading: false }} onLoadEarlier={async () => {}}>
                <article data-user-message="true" style={{ minHeight: 80 }}>{question}</article>
                <div style={{ height: 1800, flex: "0 0 1800px" }}>Long final answer</div>
              </ConversationViewport>
            </main>;
        }
        createRoot(document.getElementById("root")).render(<Fixture />);`,
    },
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"test"' },
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setContent('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>');
  await page.addStyleTag({ path: resolve("src/web/styles.css") });
  await page.addStyleTag({ content: "#root { zoom: 1.1; } .timeline-scroll { overflow-anchor: none; }" });
  await page.addScriptTag({ content: fixture.outputFiles[0].text });

  const viewport = page.getByTestId("timeline-scroll");
  const initialScrollTop = await viewport.evaluate((element) => {
    element.tabIndex = -1;
    element.focus();
    return element.scrollTop;
  });
  await Promise.all([
    viewport.evaluate((element) => new Promise<void>((resolveScroll) => {
      element.addEventListener("scrollend", () => resolveScroll(), { once: true });
    })),
    page.keyboard.press("PageUp"),
  ]);
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeLessThan(initialScrollTop);
  const beforePin = await viewport.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    promptBottom: element.querySelector<HTMLElement>("[data-user-message='true']")!.getBoundingClientRect().bottom,
  }));
  expect(beforePin.promptBottom).toBeLessThanOrEqual(
    await viewport.evaluate((element) => element.getBoundingClientRect().top),
  );
  await page.evaluate(() => (window as unknown as { enablePinnedQuestion: () => void }).enablePinnedQuestion());
  await expect(page.locator("#root main")).toHaveAttribute("data-current-question", /original question/);

  const pinned = page.locator(".pinned-user-question");
  await page.waitForTimeout(50);
  expect(pageErrors).toEqual([]);
  await expect(pinned).toBeVisible();
  const collapsed = await viewport.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    promptBottom: element.querySelector<HTMLElement>("[data-user-message='true']")!.getBoundingClientRect().bottom,
  }));
  expect(collapsed).toEqual(beforePin);

  await pinned.click();
  await expect(pinned).toHaveAttribute("aria-expanded", "true");
  const expanded = await viewport.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    promptBottom: element.querySelector<HTMLElement>("[data-user-message='true']")!.getBoundingClientRect().bottom,
  }));
  expect(expanded).toEqual(beforePin);

  await pinned.press("PageUp");
  await expect(page.locator("#root main")).toBeVisible();
  expect(pageErrors).toEqual([]);
});
