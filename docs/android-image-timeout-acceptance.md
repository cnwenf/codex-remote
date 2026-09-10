# Android 图片超时定位与回归

## 历史证据

- 早期 Android（`f4fc6bb`）图片使用 WebView fetch；`b441ba2`（v0.5.20）改为 CapacitorHttp，`accc552`（v0.5.21）改为分块桥接到 Java HttpURLConnection。
- `976b11e`（v0.5.27）修改取消与文件选择生命周期；`93347e4`（v0.5.32）增加 1 MB 传输副本压缩。它们没有消除独立原生 HTTP 路径。
- 用户历史反馈同时出现原生后台状态请求超时和图片超时，但聊天连接正常。它们分别走原生 HTTP 和 WebSocket，不能用聊天在线证明 HTTP 可用。
- 本机网关增加只含阶段、字节数、耗时、状态码的上传诊断。Android 模拟器原生 HTTP 对本机网关的小图和约 807 KB 图片往返成功，不能据此声称用户手机的私网问题已经复现。

## 修改

Android 图片复用已认证的聊天 WebSocket，网关处理 `gateway/image/upload`，返回图片 ID 后沿用既有消息提交协议。压缩、1 MB 上限、格式/魔数校验、私有存储和消息引用保持一致；图片数据不透传 Desktop RPC。

网关通过 ready 消息的 `imageUpload` capability 声明支持。旧网关立即提示更新 Mac；不偷偷重试有副作用的上传。iOS 保留原生 HTTP，Web 保留 fetch。切换连接后不把正在读取的图片发到另一条 socket；连接页面卸载后不因旧图片上传完成而启动旧任务。

## 可重复的故障注入

`ChatImageWebViewTest` 是 opt-in Android instrumentation。它运行真实 MainActivity/WebView，注入仅测试使用的生产模块 bundle，用原生触摸触发文件选择，返回真实 FileProvider content URI。生产压缩、FileReader、WebSocket、网关落盘和下载都实际执行。

测试代理仅让 POST /api/images 不返回，其他 HTTP 和 WebSocket 继续工作。同一 WebView 同时运行旧生产 `uploadNativeImage` 作为失败对照、新生产 `uploadImage` + `CodexSocket.uploadImage` 作为修复对照。测试不访问用户任务。

在测试用模拟器上运行（先配置 Node/pnpm、JDK 21 和 Android SDK）：

```sh
pnpm mobile:sync
pnpm exec tsx scripts/start-test-stack.ts
# 另一个终端
pnpm exec tsx scripts/image-upload-fault-proxy.ts
# 另一个终端
pnpm exec esbuild tests/fixtures/android-image-probe.ts --bundle --format=iife --outfile=/tmp/android-image-probe.js
(cd android && ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest)
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb install -r android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb push /tmp/android-image-probe.js /data/local/tmp/android-image-probe.js
adb reverse tcp:4319 tcp:4319
adb shell am instrument -w -e chatImage true -e class com.cnwenf.codexremote.ChatImageWebViewTest com.cnwenf.codexremote.test/androidx.test.runner.AndroidJUnitRunner
```

测试退出后停止两个测试服务并移除 adb reverse。测试不会修改已保存的连接/凭据；只在测试网关临时目录保存生成的图片。

`NativeImageUploadNetworkTest` 是另一个 opt-in 诊断：`-e liveImage true` 使用模拟器已保存的 QA 连接和凭据，对原有 Java 上传器做真实网络往返。它绕过 WebView，不能单独作为 Android 完整验收。

## 2026-09-10 本地结果

- TypeScript 与全量 Vitest：68 个文件、1018 项通过。
- Chrome 桌面/移动视口：62 项通过，10 项场景不适用跳过，包含图片提交。
- Android Java 单测：21 项通过；debug APK 与 instrumentation APK 编译通过。
- API 36 模拟器真实 MainActivity/WebView：两轮故障对照均通过。第一轮上传/下载 3730 B、807252 B、2233836 B 三张生成 PNG；第三张压缩为 528035 B，耗时分别 38/92/284 ms；同场旧原生 HTTP 约 30 秒后失败。
- 第二轮增加每张图片 `thread/resume` + `turn/start`，确认图片消息提交成功，测试 34.5 秒通过。使用隔离 fake Codex 任务，不发送到用户正在工作的真实任务。
- 独立代码复核发现的文件名解码和卸载后误启动任务问题已修复并有回归测试。

## 证据边界

故障注入验证的是“原生 HTTP 不响应但聊天 WebSocket 正常”时新路径能完成图片上传。用户手机未连接本机 ADB，其私网为何区别对待两条连接尚未确认；不能把模拟器故障注入写成对该手机底层网络根因的证明。iOS 真机和 Intel Mac 硬件运行不在本轮验收范围。
