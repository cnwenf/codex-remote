import { expect, test } from "@playwright/test";

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
  await expect(page.getByText("执行过程（2 项）")).toBeVisible();
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

test("keeps an unsent draft for its conversation across reload", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Access token").fill("e2e-token");
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByRole("button", { name: /codex-fixture.*\d+ 个对话/ }).click();
  await page.getByRole("button", { name: /^Fixture task，/ }).click();
  await page.getByRole("textbox", { name: "Instruction" }).focus();
  await page.getByRole("textbox", { name: "Instruction" }).fill("Unsent fixture draft");

  await page.reload();
  await page.getByRole("button", { name: /codex-fixture.*\d+ 个对话/ }).click();
  await page.getByRole("button", { name: /^Fixture task，/ }).click();
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
  await expect(page.getByRole("heading", { name: "Checks complete", level: 2 })).toBeVisible();
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

test("pins, unpins, and archives through the Desktop-aligned sidebar", async ({ page }) => {
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
  await page.getByRole("button", { name: `归档 ${archiveTitle}` }).click();
  await expect(page.getByRole("button", { name: new RegExp(`^${archiveTitle}，`) })).toHaveCount(0);
});
