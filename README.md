[简体中文](README.md) | [English](README_EN.md)

# Codex Remote

在手机或另一台电脑的浏览器中查看并操作这台 Mac 上的 Codex Desktop。项目、对话、运行状态、Todo、审批、模型、权限、图片和实时输出均来自本机 Codex 数据。

## 要求

- Apple Silicon Mac（ARM64），macOS 13 或更高版本。
- 已安装并登录 Codex Desktop，默认位置为 `/Applications/ChatGPT.app`。
- 手机或电脑可以通过可信本地私网访问这台 Mac。
- 不要把 Codex Remote 暴露到公网。

## 一键安装

在 Mac 的 Terminal 中执行：

```bash
curl -fsSL https://raw.githubusercontent.com/cnwenf/codex-remote/main/install.sh | sh
```

安装器会列出 Mac 当前可用的非回环 IPv4 地址，由你选择远程访问地址；隐藏输入 Web 登录密码；下载 GitHub 最新 Release 的 ARM64 DMG 并校验 SHA-256；安装、启动 App 并配置登录自启动。它不会使用临时 `launchctl submit` 任务。

安装完成后，退出并重新打开一次 Codex Desktop，使它启用仅监听本机的调试端口 `127.0.0.1:9229`。这个端口不会暴露给手机。

安装器最后会显示访问 URL，例如 `http://192.168.1.20:4321`。在手机浏览器打开并输入安装时设置的密码。登录 Cookie 默认保留 30 天，多个浏览器可以同时连接。

## Android 与 iPhone 客户端

从 [GitHub Releases](https://github.com/cnwenf/codex-remote/releases) 下载移动端构建产物：

- `Codex-Remote-android-arm64.apk`：适用于 ARM64 Android 手机，可直接安装；首次运行请允许通知。
- `Codex-Remote-iOS-Simulator.zip`：无需签名的 iPhone Simulator 构建，用于开发和验收。
- `Codex-Remote-iOS-unsigned.ipa`：已编译的 iPhone 真机 ARM64 包，但未签名，安装前必须使用自己的 Apple Developer Team 重新签名；仓库不包含证书或描述文件。

客户端复用 Web 对话界面。首次打开后点“新建连接”，输入名称、Mac 私网访问 URL（例如 `http://192.168.1.20:4321`）和 Web 登录密码。可保存多个连接，之后直接点击进入，也可编辑或删除；密码保存在 Android Keystore 或 iOS Keychain，不写入普通偏好设置。

Android 会用常驻低优先级通知显示当前运行中的任务，并在任务完成或失败时通知；点击通知会直接进入对应连接和对话。iOS 会在系统允许的后台刷新时更新运行状态和完成通知；iOS 不保证固定轮询频率，生产环境需要为 `CodexRemoteNativePlugin` 接入 APNs 才能获得可靠、即时的锁屏通知。

## 通过 Codex 对话安装

把下面整段 Prompt 复制给 Codex：

```text
请在我的 Apple Silicon Mac 上安装 Codex Remote。

GitHub 仓库：git@github.com:cnwenf/codex-remote.git

1. 先读取仓库 README，并查看本机所有非回环 IPv4 地址；把网卡名称和地址列给我选择，不要自行猜测，也不要使用 127.0.0.1 作为远程访问地址。
2. 询问我 Web 登录密码。不要把密码写入 URL、日志、Git、LaunchAgent plist 或命令行参数。
3. 获得选择后，严格执行 README 的 curl | sh 一键安装流程，并在安装器交互中替我选择地址和输入密码。
4. 验证 DMG 的 SHA-256、App 的 ad-hoc 签名、ARM64 架构、登录自启动配置和本机健康检查。
5. 安装完成后提醒我只需退出并重新打开一次 Codex Desktop；不要自行反复重启 Desktop。
6. 最后告诉我完整访问 URL、我设置的登录密码，以及每项验证是否通过。任何失败都要明确说明，不要声称安装成功。
```

## App 操作

`Codex Remote.app` 同时显示在 Dock 和 macOS 右上角菜单栏；点击 Dock 图标会直接打开当前 Remote Web 页面。菜单栏支持开启/关闭 Remote、修改绑定地址和 Web 登录密码、打开浏览器、查看版本与运行状态、检查 GitHub 最新版本。

密码保存在 `~/Library/Application Support/Codex Remote/token`，目录权限为 `700`，文件权限为 `600`；不会写入 plist、URL 或日志。

## 自动启动

安装器创建两个明确的当前用户 LaunchAgent：

- `local.codex-remote.app`：登录后启动并保持 Codex Remote App 运行。
- `local.codex-remote.desktop`：使用 `--remote-debugging-address=127.0.0.1 --remote-debugging-port=9229` 启动 Codex Desktop。

检查状态：

```bash
launchctl print "gui/$(id -u)/local.codex-remote.app"
launchctl print "gui/$(id -u)/local.codex-remote.desktop"
curl -fsS http://127.0.0.1:4321/health
```

## 安全说明

- 当前 DMG 使用 ad-hoc 签名，首次打开时 macOS 可能要求确认。
- 安装器必须成功校验 GitHub Release 中的 SHA-256 才会安装。
- 只在可信本地私网中使用，不要做公网端口映射。
- `4321` 只绑定所选本地私网地址和 `127.0.0.1`；`9229` 只绑定 `127.0.0.1`。
- 移动端只允许 HTTP 连接数值 IP、`localhost` 或 `.local` 主机；鉴权密码仅通过 `Authorization` Header 发送，不进入 URL。
