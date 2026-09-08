import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { expect, test } from "@playwright/test";

test("follows the next answer after closing an image preview", async ({ page }) => {
  const fixture = await build({
    stdin: {
      resolveDir: process.cwd(), loader: "tsx",
      contents: `
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { ConversationViewport } from "./src/web/components/conversation-viewport";
        import { Timeline } from "./src/web/components/timeline";
        function Fixture() {
          const [sent, setSent] = useState(false);
          const turns = {
            image: { id: "image", status: "completed", itemOrder: ["user"],
              items: { user: { id: "user", type: "userMessage", text: "Preview this image",
                imageIds: ["00000000-0000-4000-8000-000000000001"] } } },
            next: { id: "next", status: "completed", itemOrder: ["question", "answer"], items: {
              question: { id: "question", type: "userMessage", text: "Continue after preview" },
              answer: { id: "answer", type: "agentMessage", text: Array(25).fill("A paragraph in the next answer.").join("\\n\\n") + "\\n\\nPREVIEW-FINAL-OK" }
            } }
          };
          return <main style={{ height: "640px", display: "flex", flexDirection: "column" }}>
            <ConversationViewport threadId="fixture" history={{ hasMoreBefore: false, loading: false }} onLoadEarlier={async () => {}}>
              <Timeline thread={{ id: "fixture", title: "Preview", status: "idle",
                turnOrder: sent ? ["image", "next"] : ["image"], turns }} />
            </ConversationViewport>
            <button onClick={() => setSent(true)}>Send next question</button>
          </main>;
        }
        createRoot(document.getElementById("root")).render(<Fixture />);`,
    },
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"test"' },
  });
  await page.route("**/__preview-follow", (route) => route.fulfill({
    contentType: "text/html", body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>',
  }));
  await page.route("**/api/images/00000000-0000-4000-8000-000000000001", (route) => route.fulfill({
    contentType: "image/png", body: readFileSync(resolve("assets/app-icon.png")),
  }));
  await page.goto("/__preview-follow");
  await page.addStyleTag({ path: resolve("src/web/styles.css") });
  await page.addScriptTag({ content: fixture.outputFiles[0].text });
  await page.getByRole("button", { name: "预览用户上传的图片 1" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "关闭图片预览" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Send next question" }).click();
  await expect(page.getByText("PREVIEW-FINAL-OK", { exact: true })).toBeInViewport();
});

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
          const [enabled, setEnabled] = useState(false);
          window.enablePinnedQuestion = () => setEnabled(true);
          return <main data-current-question={enabled ? question : ""} style={{ height: "640px", display: "flex", flexDirection: "column" }}>
              <ConversationViewport threadId="fixture" connection="ready"
                readQuestionContext={async (request) => ({ ...request, state: "ready", revision: "generation-1",
                  question: { id: "question-1", text: question, imageCount: 0, source: "user", truncated: false, textOffset: 0 } })}
                history={{ hasMoreBefore: false, loading: false }} onLoadEarlier={async () => {}}>
                <article data-user-message="true" data-item-id="question-1" style={{ minHeight: 80 }}>{question}</article>
                <div data-question-anchor={enabled ? "true" : undefined} data-turn-id="turn-1" data-anchor-item-id="answer-1"
                  style={{ height: 1800, flex: "0 0 1800px" }}>Long final answer</div>
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
