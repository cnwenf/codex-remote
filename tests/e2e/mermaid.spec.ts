import { build } from "esbuild";
import { expect, test } from "@playwright/test";

const markdown = '```mermaid\nflowchart LR\n A[手机] --> B[Gateway]\n```\n\n```mermaid\nsequenceDiagram\n 手机->>Gateway: 请求\n Gateway-->>手机: 返回\n```\n\n```js\nconst answer = 42;\n```';

test("renders Mermaid diagrams in the real Markdown component", async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = await build({
    stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { Timeline } from './src/web/components/timeline';
      import { hydrateThread } from './src/web/state/conversation-history';
      import { initialCodexState } from './src/protocol/thread-store';
      const root = createRoot(document.getElementById('root'));
      window.showMarkdown = (text) => root.render(<Timeline thread={hydrateThread(initialCodexState, {thread:{id:'t',turns:[{id:'turn',status:'completed',items:[{id:'a',type:'agentMessage',text}]}]}}).threads.t} />);
      window.showMarkdown(${JSON.stringify(markdown)});`,
    },
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"test"' },
  });
  await page.route("**/__mermaid", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>' }));
  await page.goto("/__mermaid");
  await page.addStyleTag({ path: "src/web/styles.css" });
  await page.addScriptTag({ content: fixture.outputFiles[0].text });
  const diagrams = page.getByRole("img", { name: "Mermaid 图表" });
  await expect(diagrams).toHaveCount(2);
  for (const diagram of await diagrams.all()) {
    await expect(diagram).toBeVisible();
    await expect.poll(() => diagram.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    expect(await diagram.evaluate(image => image.getBoundingClientRect().right <= innerWidth)).toBe(true);
    const svg = await diagram.getAttribute("src");
    expect(decodeURIComponent(svg!)).toContain("手机");
    expect(decodeURIComponent(svg!)).not.toContain("<foreignObject");
  }
  await expect(page.locator("code.language-js")).toHaveText("const answer = 42;\n");
  await page.evaluate(() => (window as unknown as {showMarkdown:(text:string)=>void}).showMarkdown('```mermaid\nflowchart LR\n A[\n```'));
  await expect(page.getByText("图表暂无法渲染，显示源码")).toBeVisible();
  await expect(diagrams).toHaveCount(0);
  await page.evaluate((text) => (window as unknown as {showMarkdown:(text:string)=>void}).showMarkdown(text), markdown);
  await expect(diagrams).toHaveCount(2);
  let externalRequests = 0;
  await page.route("https://probe.invalid/**", route => { externalRequests++; return route.abort(); });
  await page.evaluate(() => (window as unknown as {showMarkdown:(text:string)=>void}).showMarkdown('```mermaid\nflowchart LR\n A@{ img: "https://probe.invalid/p.png", label: "x" }\n```'));
  await expect(page.getByText("图表暂无法渲染，显示源码")).toBeVisible();
  expect(externalRequests).toBe(0);
  await page.evaluate(() => (window as unknown as {showMarkdown:(text:string)=>void}).showMarkdown('```mermaid\nflowchart LR\n A@{ "i\\u006dg": "https://probe.invalid/p.png", label: "x" }\n```'));
  await expect(page.getByText("图表暂无法渲染，显示源码")).toBeVisible();
  expect(externalRequests).toBe(0);
  await page.evaluate((text) => (window as unknown as {showMarkdown:(text:string)=>void}).showMarkdown(text), markdown);
  await expect(diagrams).toHaveCount(2);
});
