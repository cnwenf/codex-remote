# Task 1：通知图标统一报告

## 结果

- `generateBrandResources` 保留 `assets/app-icon.png` 原始字节作为 `ic_launcher_source.png`，并用 JDK ImageIO 生成 96×96 白色透明小图标 `ic_stat_codex_remote.png`；删除旧手写 C 形 vector，无新增依赖。
- `CodexRemoteMonitorService` 在 Service 创建时按 `min(256px, 64dp)` 渲染一次 Launcher Drawable。ongoing、running、completed 三类通知经同一个 Builder helper 设置品牌小图标、完整大图标和黑色 accent，既有投递与跳转行为未改。
- Capacitor LocalNotifications 的 accent 从绿色统一为黑色；最终集成仍需执行既有 Capacitor sync/rebuild 流程生成派生产物。

## TDD 与根因记录

- 主任务已在旧候选 APK 上复现红测：`Notifications must include the full app logo`，证明原通知没有 large icon。
- 首轮实现后 large icon 已非空，但像素测试报告 `averageDifference=57.1279`、actual intrinsic `126×126`、expected intrinsic `745×745`。实际 PNG 显示 actual 正常、expected 图形异常缩小。
- 根因是 Launcher foreground 使用固定 `18dp` inset，而旧测试直接在 96px bounds 渲染 adaptive icon；高密度设备上 dp inset 与生产端先按 64dp 渲染的尺寸语义不同。测试现先按生产规范的 64dp（上限 256px）渲染 Launcher，再统一缩至 96×96 比较；未放宽 `< 4` 像素差阈值，也未修改 Launcher inset。
- 最终断言同时检查 large icon 与 Launcher 的完整黑底、图形及留白，以及 small icon 与来源素材的单色轮廓和来源留白。

## 验证证据

- Gradle：`:app:assembleDebug :app:assembleDebugAndroidTest :app:testDebugUnitTest` 构建成功。
- 原生 instrumentation（主任务执行，`emulator-5554`，`showNotifications=true`）：`NotificationDeliveryTest` 通过，`OK (1 test)`，耗时 51.963s。
- 原生目视（主任务执行）：点亮并滑动模拟器锁屏后看到完成通知；左侧是同品牌单色小标，右侧是完整黑底 App 图标，图形和留白符合预期。
- `ic_launcher_source.png` 与来源素材 `cmp` 一致；APK 同时包含生成的 Launcher source 与 small icon 资源。

## 自审

- 三个 `NotificationCompat.Builder` 调用已收敛到唯一品牌 helper，未加入 RemoteViews 或新抽象层。
- 完整图标仅在 Service `onCreate` 解码和渲染一次，尺寸不超过 256px。
- 仅修改 Task 1 指定实现/测试文件及本报告；未操作模拟器、未重启应用/Desktop、未发布。
- Android/OEM 会按系统主题和厂商策略着色、加底或重排状态栏单色小图标，应用不能强制所有 OEM 都显示黑底；本实现能保证输入给系统的是合规的白色透明品牌 silhouette，并为通知设置黑色 accent。

## 未覆盖项

- 本任务未执行完整 912 项仓库检查；由主任务在最终集成阶段执行 full suite。
- 删除临时 PNG 诊断输出后只做编译验证；通过的原生测试与最终测试逻辑仅相差诊断文件写出，不涉及断言或生产行为。
