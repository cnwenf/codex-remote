# Android 可靠性与品牌一致性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 修复图片上传超时和用户消息重复，将双向图片传输控制在 1 MB 以内，统一通知图标，完成真实原生验收后发布。

**Architecture:** 图片只生成传输副本，客户端上传前压缩，Mac Gateway 的图片读取接口按需提供压缩副本。消息 reconciliation 使用已核验的身份与顺序，不把相同正文当成全局唯一 ID。通知继续使用系统标准模板，完整图标复用 Launcher，单色小图标由同一素材生成。

**Tech Stack:** React/TypeScript、Node.js Gateway、Android Java/Capacitor、macOS 系统图像编码器、Vitest、Playwright、Android instrumentation。

**Spec:** 本文件的 Scope 是用户 2026-09-08 最新请求的实现契约。

**执行状态：** 源码任务及独立审查已完成，完整检查 1001 项、Web E2E 61 项、Java 单测 21 项通过。9 月 9 日三端 0.5.32 最终候选已安装，最终 Android instrumentation 5 项通过，分支 CI 完整成功；Mac 正常安装流程复核后自检与运行通过，正在完成跨端联调，尚未发版。以下保留原始任务步骤，逐项证据与未完成门禁以 [验收记录](../../android-notification-acceptance.md) 为准，不能将较早候选的原生结果当作最终包验收。

## Scope / Global Constraints

- 单张传输图片不得超过 1,000,000 bytes；不是只限制选择大小，也不能超限时原图回退。
- 原始用户图片和 session 原文不修改、不删除。会话正文不得为了压缩被全量读入。
- 图标中间图形、留白、黑色背景复用 `assets/app-icon.png` 及现有 Launcher 定义；状态栏小图标遵循 Android 单色模板限制。
- 真实重复发送的相同文字必须保留；同一次发送的 optimistic/live/history 三份投影只显示一次。
- 保留当前通知修复、既有回归断言、发布签名身份和用户连接。不得重启 Codex Desktop 或绕过系统安全门禁。
- 当前非主分支继续原地完成已有未提交任务；不擅自新建或清理其他 worktree。用户已授权全部验收后发布，不再请求流程确认。
- 不新增自研图像编解码器、不重画 logo。传输压缩失败明确报错；不靠无限重试或延长超时掩盖问题。
- 提交使用中文 conventional commit；任务工作者不发版、不修改正式安装、不创建子代理。主任务统一原生 UI 与发布验收。

## Task 1: 通知图标统一

**Files:** `android/app/build.gradle`、`android/app/src/main/res/drawable/ic_stat_codex_remote.xml`、`android/app/src/main/java/com/cnwenf/codexremote/CodexRemoteMonitorService.java`、`android/app/src/androidTest/java/com/cnwenf/codexremote/NotificationDeliveryTest.java`、`capacitor.config.ts`。

**Interfaces:** 现有三个 NotificationCompat.Builder 消费统一的品牌 Builder；小图标资源 ID 继续为 `ic_stat_codex_remote`，完整图标以 Launcher Drawable 渲染。

- [ ] 红测已添加并在旧候选 APK 复现：`Notifications must include the full app logo`。保留 `assertBranding` 中完整图标与 Launcher 的像素比较、单色图标与来源素材形状比较。
- [ ] 生成小图标：扩展现有 `generateBrandResources`，用 Java ImageIO 将来源图缩到 96×96，黑底亮度转透明度，图形为白色，保留来源留白。删除旧手写 C 图标，避免同名资源冲突，不增依赖。

```java
// 完整图标只在 Service 启动时解码一次，尺寸不超过 256 px。
int size = Math.min(256, Math.round(64 * getResources().getDisplayMetrics().density));
Bitmap logo = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
Drawable icon = getApplicationInfo().loadIcon(getPackageManager());
icon.setBounds(0, 0, size, size);
icon.draw(new Canvas(logo));
```

- [ ] 一个 helper 建立通知的 smallIcon / largeIcon / 黑色品牌 accent；ongoing、running、completed 都使用它，不自定义 RemoteViews。LocalNotifications 配置删除旧绿色 accent 或统一为黑色。
- [ ] 编译 `:app:assembleDebug :app:assembleDebugAndroidTest :app:testDebugUnitTest`；主任务在 `emulator-5554` 安装并运行 `NotificationDeliveryTest`，再真实点击通知栏和锁屏。
- [ ] 自审后提交本任务文件，提交信息 `fix(android): 统一通知与应用品牌图标`。测试报告记录不支持强制 OEM 单色小图标黑底的系统限制。

## Task 2: 双向图片传输上限与超时

**Files:** 新建 `src/protocol/image-transfer.ts`、`src/web/api/image-compression.ts`、`src/gateway/image-compression.ts` 及各自测试；修改 `src/web/api/socket.ts`、`src/gateway/image-upload-store.ts`、图片相关 API 与原生测试。不得改消息 reconciliation 或通知 Service。

**Interfaces:** `MAX_TRANSFER_IMAGE_BYTES = 1_000_000`；`compressImageForUpload(file: File): Promise<File>` 在所有 uploadImage 传输方式之前执行；Gateway `openTransfer(id)` 返回有界传输副本，原 `open` 保留历史文件语义。

**Implementation details:**

- Mac Gateway 使用已有系统 `/usr/bin/sips`（`execFile` 参数数组），不引入 native Node 图像依赖或修改打包架构。非 Mac 环境对需要压缩的图片明确报错，不返回超限原图；本项目实际 Gateway 和 release verify 都运行在 Mac。
- Web 与原生共享的客户端入口先压缩再选择 uploader；已有小于等于 1 MB 的有效类型 File 可直接使用。客户端可选择的原图上限为 50 MiB，压缩输出仍是严格 1,000,000 bytes；不扩大历史 JSONL/base64 的既有读取预算或 Gateway 原始上传兼容上限 10 MiB。
- 大图采用 JPEG 传输副本，优先最长边 2048、质量 0.9，逐步降质量至 0.6，然后按 0.75 比例缩小尺寸，固定有限重试。保留比例；透明大图采用明确背景；不重编码原始磁盘文件。小图原格式保留。
- Browser 使用标准图像解码及 Canvas，限定压缩流程 20 秒；全部路径释放 Blob URL / Canvas，压缩失败不会调用 uploader。压缩提示必须说明大图自动生成静态副本。
- 复审追加：解码前以最多 256 KiB / 128 段的图片头检查 PNG/GIF/JPEG/WebP 尺寸，单图及同一草稿预览总预算均为 32,000,000 像素，最多四张。小于 1 MB 的图片同样检查，但合格图片仍保持原始字节。压缩解码串行，网络传输保持既有并发/超时；异步选图在切换草稿和卸载时不得回填旧结果。
- Gateway 的编码子进程每次最多 5 秒、总流程最多 20 秒；预读尺寸拒绝超过 80,000,000 像素的异常大图。处理最多 2 个并发编码、最多 16 个等待；超出返回可重试错误。缓存仅压缩副本、最多 100 个文件，正在使用的副本不得被并发清理；相同源图片请求合并。
- 新增真实高熵 PNG 夹具（不是补零文件），在正常 10 MiB 原始上限以内，验证实际 JPEG 编码会触发尺寸/质量收缩。
- 上传超时目前只有用户截图的 `网络传输` 阶段证据，没有手机 logcat；不要把模拟器通过升级为已经证明手机 VPN 根因。保留现有 60 秒原生总超时和取消 cleanup，不新增自动重复 turn 提交。

- [ ] 红测：大于 1 MB 的高熵图片传给原生 uploader 和 Web fetch 前必须缩小；`GET /api/images/:id` 对历史大图片也必须返回不超过 1 MB；小图不做无谓重编码。

```ts
expect(transmitted.size).toBeLessThanOrEqual(1_000_000);
expect((await response.arrayBuffer()).byteLength).toBeLessThanOrEqual(1_000_000);
expect(readFileSync(original).equals(originalBytes)).toBe(true);
```

- [ ] 使用平台编码器，先限制最长边，再逐步降低 JPEG 质量和尺寸；每步检查实际字节数，固定迭代上限。客户端压缩包含超时、对象 URL / Canvas 释放和明确失败信息。大动图转静态传输副本须在界面或文档说明。
- [ ] Gateway 在 Mac 上调用系统编码器生成私有临时副本，使用参数数组而非 shell；有超时、并发上限与缓存边界；超限或编码失败不回传原始大图。读取单张图片按需触发，不遍历整个 session。
- [ ] 依据上传端日志/HTTP 夹具定位 `网络传输` 超时，覆盖网络超时、取消、重试和正确 cleanup；不自动重复提交用户 turn。
- [ ] 在 Android WebView 上选择高熵大图实际发送，确认 Mac/Desktop 收到的文件大小、消息只有一份；再验证 Desktop→Android 和旧历史图片。补 iPhone 共享路径冒烟。
- [ ] 自审、任务审查与中文提交；报告精确大小、原生和 Web 的证据边界。

## Task 3: 用户消息重复回归

**Files:** `src/web/state/use-codex.ts`、`src/web/state/conversation-history.ts`、相应 reducer/协议文件和测试，以只读历史审计结果确定最小范围。

**Interfaces:** 保持真实 clientMessageId / itemId / turnId 身份，重连与历史替换是同一条逻辑消息的投影；不得把正文作为全局唯一键。

**Verified design detail:** 在既有可信一对一 reconciliation 成立时，将真实旧 item ID 作为有界、turn-scoped alias 保留下来；reducer 后续重放通过该 alias 更新现有 canonical item。snapshot/prepend/append 都必须保留已确认关联，不能按 `msg_` 前缀或 UUID 时间猜 ID。若需覆盖 history-first/live-later，现成 rollout `item_completed/UserMessage` 携带真实 live ID，可在同 turn、局部记录段的一对一结构成立且内容相符时提供 alias；不能再 append 成另一条用户消息。保留 response_item 的历史 canonical ID，避免破坏原问题索引 / source-visible 的严格身份匹配；该扩展必须有分页边界、同文多次、纯图、重复完成事件反例，否则先只实现已复现的 alias 丢失修复。

不要为了补齐 start 的 clientMessageId 而直接给未知上游协议添加参数：本机实际 start / steer 完成事件均不带客户端身份字段，且只有 turn/steer 走现有 ownerRequest 转换。若没有受支持的完整传递契约，使用已证实的 item identity 修复，不把假定的参数透传作为根治。

- [ ] 阅读 `artifacts/duplicate-regression-audit.md`，对照历史修复 SHA 与当前行为。
- [ ] 红测至少覆盖 start ack/live/history 顺序变换、同文两次发送、不同图片同文、排队与 steer、重连 replay；用真实身份字段构造反例。

```ts
expect(visibleUserMessages(afterOneSubmission)).toHaveLength(1);
expect(visibleUserMessages(afterTwoRealSubmissions)).toHaveLength(2);
```

- [ ] 只修复审计确认的身份传递或投影合并问题，保留已有同文消息丢失修复；不全局删除相同正文。
- [ ] 运行 state 相关 Vitest 与真实 Android 多轮发送/重连，按用户问题、图片、最终回复逐项计数。
- [ ] 自审、任务审查与中文提交；记录本轮修复覆盖的历史反例。

## Task 4: 整体验收与发布

**Files:** `docs/android-notification-acceptance.md`、发布说明、版本文件与现有发布脚本。

- [x] 全量 `NODE_OPTIONS=--max-old-space-size=2048 pnpm check --maxWorkers=1 --reporter=dot`、`pnpm e2e`、Android 单测；跳过项不得算通过。
- [x] 最终候选 Android instrumentation；包含新失败通知与重播断言，5 项通过。
- [ ] Android 实际页面验收：连接、正常/大图发送、同文多次、排队、重连、双向图片、通知权限关闭/恢复、运行/完成通知和锁屏图标。
- [ ] 核对候选 Mac Gateway 与 Android APK 都含本轮 commit；先完成候选联调，再进入正式发布。不得只用模拟 HTTP 夹具替代所有跨端验收。
- [ ] 完成全分支代码审查，消除阻塞问题。复用固定 Android 发布证书，验签后发布；不转调试签名、不旋转密钥。
- [ ] 按 maintaining-codex-remote 发布流程更新版本、打包、GitHub Release，核对 CI、assets、sha256、签名和安装运行版本；最后只报告真实完成层次。

## 当前已有证据

- 通知修复：TypeScript 与 912 项 Vitest 通过；21 项 Java 单测通过；Web E2E 57 通过、9 跳过；原生通知测试通过（增加品牌断言之前）。
- Android debug 模拟器已实际看到运行通知和完成通知；权限关闭提示、系统设置跳转、恢复提示消失已实际点击通过。
- 固定正式 APK v0.5.31 验签通过，证书 SHA-256 与仓库固定发布身份一致；手机具体安全警告仍未取得完整截图，不能认定为“未签名”。
