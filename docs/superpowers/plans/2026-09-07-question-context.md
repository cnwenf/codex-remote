# Question Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 不加载完整历史即可置顶当前回答对应的用户问题，并在真实移动端验收后发布。

**Architecture:** Remote 自有持久小索引，以异步分块方式提取问题和身份关系。现有 RPC 适配该索引；前端只识别可见回答锚点并按需取问题，复用零高度置顶层。

**Tech Stack:** TypeScript、Node 24 fs/node:sqlite、React、现有 Vitest/Playwright、Capacitor。

**Spec:** `docs/superpowers/specs/2026-09-07-question-context-design.md`

## Execution status

- Task 1 completed in `532ae11`; independent review and 3 GiB bounded-memory benchmark passed.
- Task 2 completed through `83208bd`, including index cache repair in `a58f9ec`; startup-state, native command identity, raw output and nested image semantic-count regressions are covered. Independent scoped review approved. Source-adapter comparisons passed for 17 question contexts, 3 cold tool histories and 3 native-origin images.
- Task 3 completed in `f3a169b`, with the final full-source-identity visibility repair in `0e4891a`. Whole-feature review and scoped re-review findings are closed; the new collision regressions and existing expansion behavior pass.
- Task 4 in progress (2026-09-08). The final candidate is now installed and running on macOS, Android and iPhone simulators; all seven installed Web resources match. The normal macOS installation passes its self-test without changing security settings or restarting Desktop; the previous build-directory execution failure is no longer an installation blocker.
- Installed Gateway comparisons passed 17 original question contexts and three historical native/tool images. Actual Web queue/steer, duplicate questions, native Android 10 MiB upload and iPhone photo upload passed with cross-device previews. Seven new turns/eight user inputs, command bodies, final answers and two uploaded image hashes match installed RPC history. Gateway restart recovers in 3.7 seconds; draft, native scroll/tool state and Desktop process survive.
- Real UI acceptance found and fixed a misleading command summary: existing results were labeled missing although the disclosure had their complete bodies. Four regression cases cover nonempty, empty, missing and pending results; independent review approved the minimal shared-renderer fix. Final integrated check now passes 823 tests using `--maxWorkers=1`; full Web E2E passes 55 tests with nine existing platform skips. The new packages have been reinstalled and the summary rechecked in both simulators. Formal publication and independent official-asset verification remain pending.
- Detailed per-step evidence and execution rulings: `.superpowers/sdd/2026-09-07-question-context/progress.md` (local execution ledger, not a published acceptance claim).

## Global Constraints

- 不新增依赖，不修改 Desktop SQLite、原始 session 或已保存连接，不重启 Codex Desktop。
- 固定 64 KiB 读块；禁止读入整个 session/巨大单行。问题每段最多4096字符，缓存总计最多8MiB。
- 来源、thread/turn/item/generation 必须精确；同文不同消息不能合并，找不到不猜。
- 原生与Web、源码与安装包、CI与正式资产分别验证。没有证据不能声称通过。
- 既有本轮脏改动保留；实施者只修改任务范围，不提交其他人的修改，不自行发布。
- 用户已授权继续实现与验收后发布，无需再次询问。历史 v0.5.27 tag 不重写，新发布使用未占用版本。

---

### Task 1: 有界问题索引

**Files:**
- Create: `src/protocol/question-context.ts`
- Create: `src/gateway/question-records.ts`, `src/gateway/question-records.test.ts`
- Create: `src/gateway/question-index.ts`, `src/gateway/question-index.test.ts`

**Interfaces:**
- Consumes: validated local rollout path supplied by DesktopState, and `QuestionContextRequest` from the spec.
- Produces: `QuestionIndex` with `constructor(databasePath: string)`, `read(rolloutPath: string, request: QuestionContextRequest): QuestionContext`, `close(): void`; exports `QuestionContextRequest` / `QuestionContext` from protocol file. `read` schedules single-flight background work and returns pending immediately if necessary. No browser or gateway startup dependencies.

- [ ] **Step 1: 写真实临时文件/SQLite失败用例。** 核心断言：

```ts
const request = { threadId: 't', turnId: 'turn-1', anchorItemId: 'answer-1' };
expect(index.read(rolloutPath, request).state).toBe('pending');
await waitFor(() => expect(index.read(rolloutPath, request)).toMatchObject({
  state: 'ready', question: { id: 'user-1', text: '解释这段日志', source: 'user' },
}));
```

测试工具正文巨大、同轮user1→answer1→user2→answer2、同文不同id、纯图、严格委派、half-record补全、append无需重扫、替换/截断失效。巨图字段顺序反转与metadata在大字符串之后也必须读取到身份。测试助手/工具内容不作为问题。

- [ ] **Step 2: 运行 `pnpm exec vitest run src/gateway/question-records.test.ts src/gateway/question-index.test.ts`，记录缺少功能导致的RED。**
- [ ] **Step 3: 实现小型选择性记录提取、异步扫描、SQLite持久关联。** 函数职责是读取/投影/索引，不引入通用框架。核心调度契约：

```ts
read(path, request) {
  const file = validateGeneration(path);
  scheduleSingleFlight(file);
  return lookupIndexedContext(file, request) ?? pendingContext(request, file.generation);
}
```

扫描按64KiB异步块处理并yield；仅完成记录提交进度。默认问题截取4096字符并保存源偏移，textOffset续读定位相同问题。只保留图片计数，不读取图片文件或解码base64。SQLite所有关联索引含generation；旧任务提交前重验generation。数据库缓存/内存缓存硬上限，close清理自己持有的读取与数据库资源。
- [ ] **Step 4: 上述定向测试GREEN，`pnpm exec tsc --noEmit`与diff检查，写详细报告。** 记录未集成边界，禁止跑全量/build/install。
- [ ] **Step 5: root生成任务diff包并独立复核规格与代码；通过后由root显式提交本任务文件。**

### Task 2: RPC适配与上下文一致性

**Files:**
- Modify: `src/gateway/desktop-state.ts`, `src/gateway/desktop-state.test.ts`
- Modify only if needed: `src/gateway/server.ts`, `src/gateway/server.test.ts`
- For the confirmed native acceptance race: `src/web/state/conversation-history.ts`, `.test.ts`, `src/web/state/use-codex.test.tsx` (targeted regression only).
- For the confirmed raw CommandExecution output dialect: `src/protocol/tool-content.ts`, `.test.ts` (shared bounded normalization only).

**Interfaces:**
- Consumes: Task 1 protocol and QuestionIndex.
- Produces: `desktopState/readQuestionContext` route; latest readThread response optionally `questionContext: QuestionContext` (pending is allowed and never delays message page).

- [ ] **Step 1: 新RPC未支持RED；使用现有DesktopState临时DB fixture，用户输入在分页窗口之外，断言上下文仍最终可用。**

```ts
expect(await state.request('desktopState/readQuestionContext', {
  threadId: 't', turnId: 'turn-1', anchorItemId: 'answer-1',
})).toMatchObject({ threadId: 't', turnId: 'turn-1' });
```

- [ ] **Step 2: 先运行 `pnpm exec vitest run src/gateway/desktop-state.test.ts src/gateway/server.test.ts` 留RED证据。**
- [ ] **Step 3: 参数校验后复用readThreadRow/validateRolloutPath，调用index；close关闭索引。** 拒绝空ID、过长ID、非整数/负textOffset、不存在/不允许的thread和越界来源；客户端不能指定文件路径。历史页附带目标最新turn上下文，旧页按对应turn返回，不混用跨来源最新状态。
- [ ] **Step 4: RPC鉴权、非法路径/ID、索引pending/ready/失败和尾页缺原始问题用例GREEN；记录报告。**
- [ ] **Step 4b: 关闭真实验收复现的提前idle启动竞态。** `task_started`已存在但user尚未落盘时保留空inProgress轮；旧/空idle快照不得关闭比快照最新轮更新的本地活动轮。仅明确较新的终态可收敛之前的旧运行轮，同ID明确completed/interrupted仍正常结束。保留真实终态不可逆，测试启动→旧快照→commentary→最终完成时Queue/Send状态。不要使用全局时间宽限或全面允许terminal重开掩盖身份问题。
- [ ] **Step 4c: 保留已落盘原生命令卡。** 真实R27回归发现 `event_msg.item_completed` 中的 CommandExecution 被忽略，导致live 6/3/3项冷读变4/2/2。复用现有协议工具输入/结果有界提取，以确切turn/item ID恢复原生命令，不按正文去重、不挪到当前其他轮；测试冷/热结构一致及同ID重放一次。未经开始身份确认的历史完成记录不能制造新运行轮。
- [ ] **Step 5: root独立复核与显式提交。**

### Task 3: 可见回答定位与现有置顶栏

**Files:**
- Create: `src/web/state/use-question-context.ts`, `src/web/state/use-question-context.test.tsx`
- Modify: `src/web/app.tsx`, `src/web/app.test.tsx`
- Modify: `src/web/components/conversation-viewport.tsx`, `.test.tsx`
- Modify: `src/web/components/timeline.tsx`, `.test.tsx`, `src/web/styles.css`
- Modify if needed: `src/web/state/use-codex.ts` (single RPC forwarding method only)
- Modify minimally: `src/web/api/socket.ts`, `.test.ts` for optional per-request cancellation so question lookups release pending requests on anchor change/unmount; existing callers retain behavior.
- Create: `tests/e2e/question-context.spec.ts`
- Adapt only as needed: existing pinned-question E2E in `tests/e2e/codex-web.spec.ts`, its `scripts/start-test-stack.ts` / `tests/fixtures/fake-codex.mjs` fixtures, and `tests/e2e/conversation-viewport-layout.spec.ts` to the new RPC-backed contract.

**Interfaces:**
- Consumes: QuestionContextRequest/QuestionContext, socket RPC adapter.
- Produces: viewport-visible anchor `{turnId, anchorItemId?}`; `useQuestionContext` handles lookup, retry and stale isolation; zero-flow pinned question presents source/text/imageCount/loading/error and text continuation.

- [ ] **Step 1: 不渲染userMessage，仅渲染assistant/tool，接口给问题时置顶出现；旧轮/同轮补充切换与迟到响应隔离先RED。**

```tsx
expect(screen.getByRole('button', { name: /原始问题：解释这段日志/ })).toBeVisible();
expect(screen.queryByTestId('offscreen-original-user')).not.toBeInTheDocument();
```

测试锚点由当前可见的回答/工具获得，非全量DOM扫描；先测试纯选择函数的固定几何输入，再测真实浏览器布局。连续流式更新不能重置展开文本、重发相同请求、抢滚动。
- [ ] **Step 2: 运行针对hook/viewport/App的Vitest与新增Playwright用例，记录RED。**
- [ ] **Step 3: 实现request去重/小缓存/有界backoff、卸载清理、零高度置顶呈现。** 只识别已渲染区域的anchor，跨turn立即清除旧问题；pending显示定位中，not_found/error明确提示；纯图用图片计数；展开每次追加一个4096字符页；源questionId变化清空展开状态。不要改动既有QA正文、工具分组或消息reconciliation。
- [ ] **Step 4: 定向测试GREEN；真实移动宽度PageUp/Down、展开、工具details变化不出现React更新循环或横向溢出。**
- [ ] **Step 5: root独立复核与显式提交。**

### Task 4: 大session、真实双端验收与发布

**Files:**
- Create: `scripts/benchmark-question-index.mjs` (self-contained temporary fixture and read-only benchmark).
- Modify version fields: `package.json`, `android/app/build.gradle`, `ios/App/App.xcodeproj/project.pbxproj` and existing alignment tests only as required by repo.
- Update: release notes under existing project convention; ignored local acceptance records.

**Interfaces:**
- Consumes: integrated feature plus existing native build/release scripts.
- Produces: independently verified release assets and installed local runtime, or exact unresolved blocker with no false success.

- [ ] **Step 1: 运行大文件基准，记录总size、读取字节、峰值RSS与事件循环延迟。** 3GiB+合法JSONL由固定块流式写到mktemp目录，不在内存生成；包括超过64MiB的工具/图片字符串和正常前后问答。命中查询不得重扫整文件，巨大单行不得线性内存累积。只清理该测试创建的精确临时目录。
- [ ] **Step 2: `pnpm check --maxWorkers=1`、`pnpm e2e`、diff/敏感数据扫描，所有相关测试通过；独立整批review。**
- [ ] **Step 3: 构建并增量安装Mac Remote/Android/iPhone，核对Web bundle摘要和网关摘要，Desktop PID不变。**
- [ ] **Step 4: 双端实际逐项打开长历史、旧轮、同轮补充、纯图/大图和复杂工具QA，对照session；验证问题在原始user尚未加载时置顶、切旧轮更新、展开续读、冷重连恢复。** 继续既有专用R27任务发图与跨端显示；不向业务任务发送指令。受支持UI工具控制原生，不能用DOM注入冒充原生点击。
- [ ] **Step 5: 精确gateway子进程中断与自动恢复，双端恢复后QA与置顶仍正确，Desktop不重启。**
- [ ] **Step 6: 核验远端/tag/version，版本递增，显式暂存中文规范提交，推送commit后新tag发布。**
- [ ] **Step 7: 等待CI全部完成，重新下载5种正式二进制与sha256，校验压缩包、DMG、签名、架构、版本、更新manifest；安装正式版本后再做本机连接和移动端关键回归。**
- [ ] **Step 8: 汇总发布链接、版本与实际通过范围；不宣称每条历史消息或VPN/蜂窝真机环境已经全验。**
