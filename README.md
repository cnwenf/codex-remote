# Codex Remote

通过浏览器访问并操作这台 Mac 上的 Codex Desktop。手机或其他电脑只要能访问 Mac 的本地私网 IP，就可以查看同一批项目、任务和实时输出。

## 使用前准备

- Mac 已安装并登录 Codex Desktop，默认路径为 `/Applications/ChatGPT.app`。
- Mac 已安装 `pnpm`。
- 手机或其他电脑能够访问 Mac 的本地私网 IP。
- 不要把本服务暴露到公网。

在项目根目录安装依赖：

```bash
pnpm install
```

查看 Mac 可用的本地私网 IP：

```bash
ifconfig | awk '/^[a-z0-9]+:/{iface=$1; sub(":$", "", iface)} /inet / && $2 != "127.0.0.1" {print iface, $2}'
```

选择手机或其他电脑能够访问的地址。下文使用 `192.168.1.20` 作为示例，请替换为当前 Mac 的实际本地私网 IP。

## 通过 Codex 对话自动安装

把下面整段 Prompt 复制给 Codex：

```text
请在我的 Mac 上安装 Codex Remote。

GitHub 地址：git@github.com:cnwenf/codex-remote.git

请按以下要求执行：
1. 先询问我两个配置，不要自行猜测：
   - Web 服务需要绑定的 Mac 本地私网 IPv4 地址。
   - Web 登录使用的鉴权 token。
2. 获得我的回复后，通过上述 SSH 地址把项目克隆到 `$HOME/code/codex-remote`。如果 GitHub SSH 鉴权失败，停下来告诉我，不要改用来源不明的仓库。如果目录已经存在，就在保留本地改动的前提下更新项目；遇到冲突时停下来说明，不要覆盖本地文件。
3. 完整阅读项目 README，严格按照 README 中的持久化安装方式操作，不要自行设计其他启动或保活方式。
4. 把我提供的鉴权 token 保存到项目的 `.runtime/token`，目录权限设置为 `700`，文件权限设置为 `600`。不要把 token 写入 URL、LaunchAgent plist、日志或 Git。
5. 使用我提供的本地私网 IP、README 指定的端口和安装脚本完成配置。安装过程需要正常重启一次 Codex Desktop；执行重启前先明确提醒我一次。
6. Desktop 重新启动后，检查 Desktop LaunchAgent、Gateway LaunchAgent、DevTools 回环监听和 Web 健康状态，并执行 README 中的 30 秒稳定性检查。
7. 安装和检查完成后，告诉我：
   - 手机或其他电脑应该访问的完整 URL。
   - Web 登录使用的鉴权 token。
   - Codex Desktop 已经完成一次重启。
   - 所有检查是否通过；如有失败，给出明确错误，不要声称安装成功。
```

## 手工持久化安装

Codex Desktop 的界面中不需要修改设置。本项目会安装两个当前用户的 macOS LaunchAgent：

- `local.codex-web.desktop`：启动 Codex Desktop，并固定增加以下参数：

  ```text
  --remote-debugging-address=127.0.0.1
  --remote-debugging-port=9229
  ```

- `local.codex-web.gateway`：在 Desktop 就绪后启动 Web 网关。

`9229` 只监听 `127.0.0.1`，手机不能直接访问这个调试端口。Web 网关通过本机调试接口连接 Desktop，再把页面提供到指定的本地私网 IP。

先检查配置，不修改系统状态：

```bash
BIND_HOST="192.168.1.20" PORT=4321 \
  scripts/persistent-bridge.sh --dry-run
```

确认无误后，在独立的 Terminal 窗口中直接安装：

```bash
BIND_HOST="192.168.1.20" PORT=4321 \
  scripts/persistent-bridge.sh --install
```

首次安装会正常退出并重新打开一次 Codex Desktop。之后：

- Mac 登录后，Desktop 和 Web 网关会自动启动。
- Desktop 或网关意外退出后，LaunchAgent 会自动拉起。
- 手工退出 Codex Desktop 后，它也会自动重新打开。
- Codex Desktop 升级后，网关会在下次启动时自动读取新的内置 Codex 版本。

如果 Codex Desktop 不在默认位置，可在上述命令前增加：

```bash
CODEX_DESKTOP_APP_PATH="/Applications/你的应用.app"
```

## 打开页面

查看登录口令：

```bash
cat .runtime/token
```

在手机或其他电脑的浏览器中打开：

```text
http://192.168.1.20:4321
```

输入 `.runtime/token` 中的口令。首次登录成功后，浏览器会保留登录 Cookie，正常刷新或重新打开页面不需要再次登录。

Mac 本机也可以访问：

```text
http://127.0.0.1:4321
```

同一个登录口令可以让手机、Mac 浏览器等多个页面同时连接。

## 检查运行状态

```bash
scripts/persistent-bridge.sh --status
```

安装或升级后，可做一次 30 秒稳定性检查：

```bash
scripts/verify-persistent-bridge-stability.sh 30
```

检查会验证 Desktop/Gateway 的 PID、运行次数和安装日志在观察期间保持不变，并确认两个服务健康。

正常结果应满足：

- Desktop 和 Gateway 的 PID 在 30 秒内不变化。
- 两个正式任务的 `runs` 在 30 秒内不增加。
- `.runtime/persistent-install.log` 不再增长。
- Desktop DevTools 和 Web 网关健康检查均成功。

也可以分别检查两个 LaunchAgent：

```bash
launchctl print "gui/$(id -u)/local.codex-web.desktop"
launchctl print "gui/$(id -u)/local.codex-web.gateway"
```

检查端口：

```bash
curl -fsS http://127.0.0.1:4321/health
lsof -nP -iTCP:4321 -sTCP:LISTEN
lsof -nP -iTCP:9229 -sTCP:LISTEN
```

其中 `4321` 应监听配置的本地私网 IP 和 `127.0.0.1`；`9229` 必须只监听 `127.0.0.1`。

查看网关日志：

```bash
tail -f .runtime/gateway.log
```

重启 Web 网关而不重启 Desktop：

```bash
launchctl kickstart -k "gui/$(id -u)/local.codex-web.gateway"
```

## 取消持久化配置

```bash
scripts/persistent-bridge.sh --uninstall
```

该命令会停止并删除两个 LaunchAgent，然后按普通方式重新打开 Codex Desktop；`.runtime/token` 会保留。

## 安全要求

- 只允许受信任的本地私网设备访问 `4321`。
- 不要把 `4321` 或 `9229` 映射到公网。
- 不要发送或提交 `.runtime/token`。
- `9229` 必须保持为仅本机监听。
