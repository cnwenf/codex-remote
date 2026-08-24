[简体中文](README.md) | [English](README_EN.md)

# Codex Remote

Access and control Codex Desktop running on this Mac from a browser. A phone or another computer that can reach the Mac's private network IP can view the same projects, tasks, and live output.

## Prerequisites

- Codex Desktop is installed and signed in on the Mac. Its default path is `/Applications/ChatGPT.app`.
- `pnpm` is installed on the Mac.
- The phone or other computer can reach the Mac's private network IP.
- Do not expose this service to the public internet.

Install dependencies from the project root:

```bash
pnpm install
```

List the Mac's available private IPv4 addresses:

```bash
ifconfig | awk '/^[a-z0-9]+:/{iface=$1; sub(":$", "", iface)} /inet / && $2 != "127.0.0.1" {print iface, $2}'
```

Choose an address reachable from the phone or other computer. The examples below use `192.168.1.20`; replace it with the Mac's actual private network IP.

## Install through a Codex conversation

Copy the entire prompt below into Codex:

```text
Install Codex Remote on my Mac.

GitHub repository: git@github.com:cnwenf/codex-remote.git

Follow these requirements:
1. First list every non-loopback IPv4 address currently available on this Mac, including the network interface name and IP address. Do not choose one yourself, and do not use `127.0.0.1` as the remote access address.
2. Show me the candidate addresses and ask me which private IPv4 address the Web service should bind to. Also ask me for the authentication token used to sign in to the Web interface. Do not guess either value.
3. After I provide the address and token, clone the project from the SSH URL above into `$HOME/code/codex-remote`. If GitHub SSH authentication fails, stop and tell me; do not switch to an untrusted repository. If the directory already exists, update it while preserving local changes. Stop and explain any conflict instead of overwriting local files.
4. Read the complete project README and follow its persistent installation instructions exactly. Do not invent another startup or keep-alive mechanism.
5. Save the authentication token I provide to `.runtime/token` in the project. Set the directory permission to `700` and the file permission to `600`. Do not put the token in a URL, LaunchAgent plist, log, or Git.
6. Use the private IP I selected, the port documented in the README, and the provided installation script to configure persistent startup. The Desktop LaunchAgent and Gateway LaunchAgent must start automatically when the current user logs in and restart after an unexpected process exit. Do not start temporary processes only. The installation must restart Codex Desktop once; explicitly warn me immediately before restarting it.
7. After Desktop restarts, confirm that both LaunchAgents are loaded and that both plists use `RunAtLoad=true` and `KeepAlive=true`. Then verify the loopback DevTools listener, Web health endpoint, and the README's 30-second stability check.
8. When installation and verification finish, tell me:
   - The complete URL to open on my phone or other computer.
   - The authentication token to use on the Web sign-in page.
   - That Codex Desktop has restarted once.
   - Whether every check passed. If anything failed, provide the exact error and do not claim that installation succeeded.
```

## Manual persistent installation

No setting needs to be changed in the Codex Desktop interface. The project installs two macOS LaunchAgents for the current user:

- `local.codex-web.desktop`: starts Codex Desktop with these fixed arguments:

  ```text
  --remote-debugging-address=127.0.0.1
  --remote-debugging-port=9229
  ```

- `local.codex-web.gateway`: starts the Web gateway after Desktop is ready.

Port `9229` listens on `127.0.0.1` only and cannot be accessed directly from the phone. The Web gateway connects to Desktop through this local debugging interface and serves the browser UI on the configured private network IP.

Validate the configuration without changing system state:

```bash
BIND_HOST="192.168.1.20" PORT=4321 \
  scripts/persistent-bridge.sh --dry-run
```

After validation succeeds, install directly from a separate Terminal window:

```bash
BIND_HOST="192.168.1.20" PORT=4321 \
  scripts/persistent-bridge.sh --install
```

The first installation normally quits and reopens Codex Desktop once. After that:

- Desktop and the Web gateway start automatically when the user logs in to the Mac.
- LaunchAgent restarts Desktop or the gateway after an unexpected exit.
- Codex Desktop also reopens after it is quit manually.
- After a Codex Desktop upgrade, the gateway reads the new bundled Codex version the next time it starts.

If Codex Desktop is not in its default location, add this before either command:

```bash
CODEX_DESKTOP_APP_PATH="/Applications/Your App.app"
```

## Open the Web interface

Display the sign-in token:

```bash
cat .runtime/token
```

Open this URL in the phone or other computer's browser:

```text
http://192.168.1.20:4321
```

Enter the token stored in `.runtime/token`. After the first successful sign-in, the browser keeps a login cookie, so refreshing or reopening the page does not normally require another sign-in.

The Mac itself can use:

```text
http://127.0.0.1:4321
```

The same sign-in token can be used by multiple pages, including the phone and a browser on the Mac, at the same time.

The conversation composer supports selecting or pasting PNG, JPEG, GIF, and WebP images. Each image can be up to 10 MB, with at most four images per message. Images are stored in a private directory on this Mac and sent to the same Codex Desktop conversation as local image input.

## Check service status

```bash
scripts/persistent-bridge.sh --status
```

After installation or an upgrade, run the 30-second stability check:

```bash
scripts/verify-persistent-bridge-stability.sh 30
```

The check confirms that the Desktop and Gateway PIDs, run counts, and installation log remain stable during the observation period, and that both services are healthy.

A healthy result requires:

- Desktop and Gateway PIDs do not change during the 30 seconds.
- The `runs` count for both persistent jobs does not increase.
- `.runtime/persistent-install.log` stops growing.
- Both the Desktop DevTools and Web gateway health checks succeed.

Inspect the LaunchAgents individually:

```bash
launchctl print "gui/$(id -u)/local.codex-web.desktop"
launchctl print "gui/$(id -u)/local.codex-web.gateway"
```

Inspect the listening ports:

```bash
curl -fsS http://127.0.0.1:4321/health
lsof -nP -iTCP:4321 -sTCP:LISTEN
lsof -nP -iTCP:9229 -sTCP:LISTEN
```

Port `4321` should listen on both the configured private network IP and `127.0.0.1`. Port `9229` must listen on `127.0.0.1` only.

Follow gateway logs:

```bash
tail -f .runtime/gateway.log
```

Restart the Web gateway without restarting Desktop:

```bash
launchctl kickstart -k "gui/$(id -u)/local.codex-web.gateway"
```

## Remove persistent configuration

```bash
scripts/persistent-bridge.sh --uninstall
```

This stops and removes both LaunchAgents, then opens Codex Desktop normally. The `.runtime/token` file is preserved.

## Security requirements

- Allow only trusted private network devices to access port `4321`.
- Do not expose ports `4321` or `9229` to the public internet.
- Do not send or commit `.runtime/token`.
- Keep port `9229` bound to the local machine only.
