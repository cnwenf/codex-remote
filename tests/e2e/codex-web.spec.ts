import { expect, test } from "@playwright/test";

test("confirms a one-time Desktop restart before leaving read-only mode", async ({ page }) => {
  test.skip(process.env.CODEX_REMOTE_E2E_DESKTOP_MIRROR !== "1", "read-only Desktop fixture only");
  await page.goto("/");
  await page.getByLabel("Access token").fill("e2e-token");
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByRole("button", { name: /codex-fixture.*\d+ 个对话/ }).click();
  await page.getByRole("button", { name: /^Desktop restart fixture，/ }).click();
  await expect(page.getByText(/Desktop 桥当前不可用/)).toBeVisible();
  await page.getByRole("button", { name: "重启 Desktop 恢复控制" }).click();
  const dialog = page.getByRole("dialog", { name: "重启 Codex Desktop" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("1 个对话正在运行");
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toHaveCount(0);
});

test("follows the system theme and keeps mobile navigation actions in thumb reach", async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await page.getByLabel("Access token").fill("e2e-token");
  await page.getByRole("button", { name: "Connect" }).click();

  const lightTheme = await page.evaluate(() => ({
    scheme: getComputedStyle(document.documentElement).colorScheme,
    canvas: getComputedStyle(document.body).backgroundColor,
  }));
  expect(lightTheme.scheme).toContain("light");

  const footer = page.locator(".task-nav-footer");
  await expect(footer).toBeVisible();
  if (testInfo.project.name === "chrome-mobile") {
    const footerBox = await footer.boundingBox();
    expect(footerBox).not.toBeNull();
    expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  }

  await page.emulateMedia({ colorScheme: "dark" });
  const darkTheme = await page.evaluate(() => ({
    scheme: getComputedStyle(document.documentElement).colorScheme,
    canvas: getComputedStyle(document.body).backgroundColor,
  }));
  expect(darkTheme.scheme).toContain("dark");
  expect(darkTheme.canvas).not.toBe(lightTheme.canvas);

  await page.getByRole("button", { name: /codex-fixture.*\d+ 个对话/ }).click();
  await page.getByRole("button", { name: /^Fixture task，/ }).click();
  const headerRadius = await page.locator(".task-header").evaluate((element) => (
    Number.parseFloat(getComputedStyle(element).borderTopLeftRadius)
  ));
  expect(headerRadius).toBeGreaterThan(20);
  if (process.env.CODEX_REMOTE_CAPTURE) {
    await page.screenshot({
      path: `artifacts/theme-dark-${testInfo.project.name}.png`,
      fullPage: false,
    });
  }
});

test("keeps the browser signed in after a reload", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Access token").fill("e2e-token");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByText("Connected")).toBeVisible();

  await page.reload();

  await expect(page.getByText("Connected")).toBeVisible();
  await expect(page.getByLabel("Access token")).toHaveCount(0);
});

test("controller opens a task, streams output, denies approval, and reviews diff", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByLabel("Access token").fill("e2e-token");
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByRole("button", { name: /codex-fixture.*\d+ 个对话/ }).click();
  await page.getByRole("button", { name: /^Fixture task，/ }).click();
  const completedProcess = page.getByText("执行过程（3 项）");
  await expect(completedProcess).toBeVisible();
  await expect(page.getByText("Initial inspection complete")).toBeVisible();
  await expect(page.getByText("I checked the message grouping before running tests.")).not.toBeVisible();
  await completedProcess.click();
  await expect(page.getByText("I checked the message grouping before running tests.")).toBeVisible();
  await page.getByRole("textbox", { name: "Instruction" }).click();
  await expect(page.getByRole("combobox", { name: "模型" })).toHaveValue("gpt-fixture");
  await expect(page.getByRole("combobox", { name: "思考强度" })).toHaveValue("medium");
  await expect(page.getByRole("button", { name: "权限：请求批准" })).toBeVisible();
  await page.getByRole("button", { name: "权限：请求批准" }).click();
  await expect(page.getByRole("option", { name: /请求批准.*编辑外部文件和使用互联网时始终询问/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /帮我批准.*仅对检测到的风险操作请求批准/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /完全访问权限.*可不受限制地访问互联网和你电脑上的任何文件/ })).toBeVisible();
  await page.getByRole("option", { name: /^请求批准 / }).click();
  await page.getByRole("textbox", { name: "Instruction" }).fill("Run checks");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByRole("heading", { name: "Checks complete", level: 2 })).toBeVisible();
  await expect(page.locator(".markdown-body ul")).toContainText("All tests passed");
  const todoTrigger = page.getByRole("button", { name: "任务进度，第 2/3 步" });
  await expect(todoTrigger).toBeVisible();
  const todoBox = await todoTrigger.boundingBox();
  const composerBox = await page.locator(".composer").boundingBox();
  expect(todoBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  expect(todoBox!.y + todoBox!.height).toBeLessThanOrEqual(composerBox!.y);
  await expect(page.getByText("Run checks", { exact: true }).last()).toBeVisible();
  const approval = page.getByRole("dialog", { name: "Run a command?" });
  await expect(approval).toBeVisible();
  await expect(approval.getByText("pnpm test", { exact: true })).toBeVisible();
  await expect(approval.getByText("/tmp/codex-fixture", { exact: true })).toBeVisible();
  await expect(approval.getByRole("button", { name: "Approve once" })).toBeVisible();
  await expect(approval.getByRole("button", { name: "Deny" })).toBeVisible();
  const approvalBox = await approval.boundingBox();
  expect(approvalBox).not.toBeNull();
  expect(approvalBox!.x).toBeGreaterThanOrEqual(0);
  expect(approvalBox!.y).toBeGreaterThanOrEqual(0);
  expect(approvalBox!.x + approvalBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(approvalBox!.y + approvalBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await approval.getByRole("button", { name: "Deny" }).click();
  await expect(approval).toHaveCount(0);
  if (testInfo.project.name === "chrome-desktop") {
    await todoTrigger.dispatchEvent("click");
    await expect(page.getByLabel("任务进度，1/3 已完成")).toBeVisible();
  }
  if (process.env.CODEX_REMOTE_CAPTURE) {
    await page.screenshot({
      path: `artifacts/acceptance-${testInfo.project.name}.png`,
      fullPage: false,
    });
  }
  await expect(page.locator(".decision-toast", { hasText: "Request denied" })).toBeVisible();
  if (await page.getByRole("button", { name: "Steer" }).count() === 0) {
    await page.getByRole("textbox", { name: "Instruction" }).fill("Start a mobile fixture run");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("button", { name: "Steer" })).toBeVisible();
  }
  await page.getByRole("textbox", { name: "Instruction" }).fill("Steer follow-up from Web");
  await page.getByRole("button", { name: "Steer" }).dispatchEvent("click");
  const steerMessage = page.locator(".message-user", { hasText: "Steer follow-up from Web" });
  await expect(steerMessage).toHaveCount(1);
  await expect(steerMessage).toBeVisible();
  await expect(approval).toBeVisible();
  await approval.getByRole("button", { name: "Deny" }).click();
  await expect(todoTrigger).toHaveCount(0);
  await page.getByTestId("timeline-scroll").dispatchEvent("pointerdown");
  await page.getByText("查看代码变更").click();
  await expect(page.getByLabel("Unified diff")).toContainText("fixture.txt");

  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
});

test("pins the latest long user question in two lines after it leaves the mobile viewport", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chrome-mobile", "mobile conversation behavior");
  await page.goto("/");
  await page.getByLabel("Access token").fill("e2e-token");
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByRole("button", { name: /codex-fixture.*\d+ 个对话/ }).click();
  await page.getByRole("button", { name: /^Fixture task，/ }).click();

  const question = "请持续检查这个很长的移动端任务，并且在回答很多轮以后仍然让我能看到最初的问题内容和完整上下文。";
  await page.getByRole("textbox", { name: "Instruction" }).fill(question);
  await page.getByRole("button", { name: "Send" }).click();
  const viewport = page.getByTestId("timeline-scroll");
  await expect(page.locator(".message-user", { hasText: question })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Checks complete", level: 2 })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Run a command?" })).toBeVisible();
  await page.locator(".activity-group").last().evaluate((element: HTMLDetailsElement) => {
    element.open = true;
  });
  await page.locator(".diff-panel").evaluate((element: HTMLDetailsElement) => {
    element.open = true;
  });
  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => viewport.evaluate((element) => {
    const prompts = element.querySelectorAll<HTMLElement>("[data-user-message='true']");
    const prompt = prompts.item(prompts.length - 1);
    return Boolean(prompt && prompt.getBoundingClientRect().bottom <= element.getBoundingClientRect().top);
  })).toBe(true);

  const pinned = page.locator(".pinned-user-question");
  await expect(page.getByRole("button", { name: `展开原始问题：${question}` })).toBeVisible();
  await expect(pinned).toHaveText(question);
  expect(await pinned.locator("span").evaluate((element) => getComputedStyle(element).webkitLineClamp)).toBe("2");

  await pinned.click();
  await expect(pinned).toHaveAttribute("aria-expanded", "true");
  await page.locator(".task-header").dispatchEvent("pointerdown");
  await expect(pinned).toHaveAttribute("aria-expanded", "false");

  await viewport.evaluate((element) => {
    const prompts = element.querySelectorAll<HTMLElement>("[data-user-message='true']");
    prompts.item(prompts.length - 1)?.scrollIntoView({ block: "start" });
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(page.getByRole("button", { name: `展开原始问题：${question}` })).toHaveCount(0);

  await expect(page.locator(".typing-dot")).toHaveCount(3);
  await page.getByRole("textbox", { name: "Instruction" }).focus();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).dispatchEvent("click");
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
  await expect(page.locator(".task-status")).toHaveText("空闲");
  await expect(page.locator(".typing-dot")).toHaveCount(0);
  await page.getByRole("button", { name: "返回对话列表" }).click();
  await expect(page.getByRole("button", { name: /^Fixture task，空闲/ })).toBeVisible();
});

test("keeps an unsent draft for its conversation across reload", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Access token").fill("e2e-token");
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByRole("button", { name: /codex-fixture.*\d+ 个对话/ }).click();
  await page.getByRole("button", { name: /^Fixture task，/ }).click();
  await page.getByRole("textbox", { name: "Instruction" }).focus();
  await page.getByRole("textbox", { name: "Instruction" }).fill("Unsent fixture draft");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Fixture task" })).toBeVisible();
  await page.getByRole("textbox", { name: "Instruction" }).focus();

  await expect(page.getByRole("textbox", { name: "Instruction" })).toHaveValue("Unsent fixture draft");
});

test("uploads an image and sends it with the conversation", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Access token").fill("e2e-token");
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByRole("button", { name: /codex-fixture.*\d+ 个对话/ }).click();
  await page.getByRole("button", { name: /^Fixture task，/ }).click();
  await page.getByRole("textbox", { name: "Instruction" }).click();

  await page.getByLabel("添加图片").setInputFiles({
    name: "screen.png",
    mimeType: "image/png",
    buffer: Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
  });
  await expect(page.getByText("screen.png")).toBeVisible();
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText("screen.png")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "打开用户上传的图片 1" })).toBeVisible();
  await expect(page.getByText("等待输入…")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Checks complete", level: 2 })).toBeVisible();

  await expect(page.getByRole("button", { name: "Steer" })).toBeVisible();
  await page.getByLabel("添加图片").setInputFiles({
    name: "running-only.png",
    mimeType: "image/png",
    buffer: Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
  });
  await page.getByRole("button", { name: "Steer" }).dispatchEvent("click");
  await expect(page.getByText("running-only.png")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /打开用户上传的图片/ })).toHaveCount(2);
  await expect(page.getByText("等待输入…")).toHaveCount(0);
});

test("new conversation selects project permission model and reasoning effort", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Access token").fill("e2e-token");
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByRole("button", { name: "新对话" }).click();

  await page.getByRole("combobox", { name: "项目" }).selectOption("/tmp/codex-fixture");
  await page.getByRole("combobox", { name: "权限" }).selectOption("full-access");
  await page.getByRole("combobox", { name: "模型" }).selectOption("gpt-fixture");
  await page.getByRole("combobox", { name: "思考强度" }).selectOption("high");
  await page.getByRole("button", { name: "创建对话" }).click();

  await expect(page.getByRole("heading", { name: "New fixture conversation" })).toBeVisible();
});

test("new direct conversation stays outside project groups", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Access token").fill("e2e-token");
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByRole("button", { name: "新对话" }).click();
  await page.getByRole("button", { name: "创建对话" }).click();

  await expect(page.locator(".task-header .eyebrow")).toHaveText("直接对话");
  if ((page.viewportSize()?.width ?? 0) < 760) {
    await page.getByRole("button", { name: "返回对话列表" }).click();
  }
  await expect(
    page.getByRole("region", { name: "最近" })
      .getByRole("button", { name: /^New fixture conversation，/ }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /direct-conversation.*1 个对话/ })).toHaveCount(0);
});

test("mobile task list and conversation scroll independently", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await page.goto("/");
  await page.getByLabel("Access token").fill("e2e-token");
  await page.getByRole("button", { name: "Connect" }).click();

  const taskList = page.getByTestId("task-list-scroll");
  await expect(taskList).toBeVisible();
  await page.getByRole("button", { name: /codex-fixture.*\d+ 个对话/ }).click();
  const taskScroll = await taskList.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return { top: element.scrollTop, overflow: element.scrollHeight > element.clientHeight };
  });
  expect(taskScroll.overflow).toBe(true);
  expect(taskScroll.top).toBeGreaterThan(0);

  await page.getByRole("button", { name: /^Fixture task，/ }).click();
  await expect(page.getByText("Follow-up instruction 10")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Fixture task" })).toHaveCount(1);
  const taskHeaderBounds = await page.locator(".task-header").boundingBox();
  expect(taskHeaderBounds).not.toBeNull();
  expect(taskHeaderBounds!.height).toBeLessThanOrEqual(80);
  const codeBlock = page.locator(".message-agent pre").last();
  await expect(codeBlock).toBeVisible();
  const codeBounds = await codeBlock.boundingBox();
  const timelineBounds = await page.locator(".timeline").boundingBox();
  expect(codeBounds).not.toBeNull();
  expect(timelineBounds).not.toBeNull();
  expect(codeBounds!.x).toBeGreaterThanOrEqual(timelineBounds!.x);
  expect(codeBounds!.x + codeBounds!.width).toBeLessThanOrEqual(
    timelineBounds!.x + timelineBounds!.width + 1,
  );
  expect(await codeBlock.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const timeline = page.getByTestId("timeline-scroll");
  await expect(timeline).toBeVisible();
  const conversationScroll = await timeline.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return { top: element.scrollTop, overflow: element.scrollHeight > element.clientHeight };
  });
  expect(conversationScroll.overflow).toBe(true);
  expect(conversationScroll.top).toBeGreaterThan(0);

  const composer = page.locator(".composer");
  await expect(composer).toHaveClass(/composer-collapsed/);
  await page.getByRole("textbox", { name: "Instruction" }).focus();
  await expect(composer).toHaveClass(/composer-expanded/);
  await timeline.dispatchEvent("pointerdown");
  await expect(composer).toHaveClass(/composer-collapsed/);
});

test("mobile browser back swipe history returns to the conversation list", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await page.goto("/");
  await page.getByLabel("Access token").fill("e2e-token");
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByRole("button", { name: /codex-fixture.*\d+ 个对话/ }).click();
  await page.getByRole("button", { name: /^Fixture task，/ }).click();
  await expect(page.getByRole("heading", { name: "Fixture task" })).toBeVisible();

  await page.evaluate(() => window.history.back());
  await expect(page.getByTestId("task-list-scroll")).toBeVisible();
  await expect(page).toHaveURL(/127\.0\.0\.1:4318\/?$/);
});

test("keeps a usable conversation viewport in a short landscape window", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto("/");
  await page.getByLabel("Access token").fill("e2e-token");
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByRole("button", { name: /codex-fixture.*\d+ 个对话/ }).click();
  await page.getByRole("button", { name: /^Fixture task，/ }).click();
  await page.getByRole("textbox", { name: "Instruction" }).focus();

  const viewport = await page.getByTestId("timeline-scroll").boundingBox();
  expect(viewport).not.toBeNull();
  expect(viewport!.height).toBeGreaterThanOrEqual(120);
});

test("shows conversation actions in one floating menu without shifting the desktop row", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Access token").fill("e2e-token");
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByRole("button", { name: /codex-fixture.*\d+ 个对话/ }).click();

  const row = page.getByRole("button", { name: /^Fixture task，/ }).locator("xpath=../..");
  await expect(row.locator(".task-row-actions")).toHaveCount(0);
  await expect(row.locator(".task-row-content")).toHaveCSS("transform", "none");

  await page.getByRole("button", { name: "对话操作 Fixture task" }).click();
  const menu = page.getByRole("menu", { name: "对话操作 Fixture task" });
  await expect(menu).toBeVisible();
  await expect(row.locator(".task-row-content")).toHaveCSS("transform", "none");
  expect(await row.evaluate((element) => element.contains(document.querySelector('[role="menu"]')))).toBe(false);
});

test("pins, renames, archives, restores, and deletes through the Desktop-aligned sidebar", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Access token").fill("e2e-token");
  await page.getByRole("button", { name: "Connect" }).click();

  await page.getByRole("button", { name: /codex-fixture.*\d+ 个对话/ }).click();
  await page.getByRole("button", { name: "对话操作 Fixture task" }).click();
  await page.getByRole("button", { name: "置顶 Fixture task" }).click();
  await expect(
    page.getByRole("region", { name: "置顶" }).getByRole("button", { name: /^Fixture task，/ }),
  ).toBeVisible();

  await page.getByRole("button", { name: "对话操作 Fixture task" }).click();
  await page.getByRole("button", { name: "取消置顶 Fixture task" }).click();
  await expect(page.getByRole("region", { name: "置顶" })).toContainText("暂无置顶对话");

  const archivedConversation = page.getByRole("button", { name: /^Fixture conversation \d+，/ }).first();
  const archiveLabel = await archivedConversation.getAttribute("aria-label");
  const archiveTitle = archiveLabel?.split("，", 1)[0] ?? "Fixture conversation 01";
  const archivedRow = archivedConversation.locator("xpath=..").locator("xpath=..");
  await archivedRow.dispatchEvent("pointerdown", { clientX: 260, clientY: 40, pointerId: 1 });
  await archivedRow.dispatchEvent("pointerup", { clientX: 110, clientY: 44, pointerId: 1 });
  await expect(archivedRow).toHaveAttribute("data-actions-open", "true");
  await page.getByRole("button", { name: `重命名 ${archiveTitle}` }).click();
  const renamedTitle = `${archiveTitle} Renamed`;
  await page.getByRole("textbox", { name: "对话标题" }).fill(renamedTitle);
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("button", { name: new RegExp(`^${renamedTitle}，`) })).toBeVisible();

  await page.getByRole("button", { name: `对话操作 ${renamedTitle}` }).click();
  await page.getByRole("button", { name: `归档 ${renamedTitle}` }).click();
  await expect(page.getByRole("button", { name: new RegExp(`^${renamedTitle}，`) })).toHaveCount(0);

  await page.getByRole("button", { name: /归档对话/ }).click();
  await expect(page.getByText(renamedTitle, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: `对话操作 ${renamedTitle}` }).click();
  await page.getByRole("button", { name: `取消归档 ${renamedTitle}` }).click();
  await expect(page.getByRole("button", { name: new RegExp(`^${renamedTitle}，`) })).toBeVisible();

  await page.getByRole("button", { name: `对话操作 ${renamedTitle}` }).click();
  await page.getByRole("button", { name: `归档 ${renamedTitle}` }).click();
  await page.getByRole("button", { name: `对话操作 ${renamedTitle}` }).click();
  await page.getByRole("button", { name: `删除 ${renamedTitle}` }).click();
  await page.getByRole("button", { name: "永久删除" }).click();
  await expect(page.getByText(renamedTitle, { exact: true })).toHaveCount(0);
});
