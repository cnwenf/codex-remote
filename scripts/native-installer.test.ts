import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const installer = readFileSync(join(root, "install.sh"), "utf8");
const agents = readFileSync(join(root, "scripts/install-launch-agents.sh"), "utf8");
const appSource = readFileSync(join(root, "macos/CodexRemoteApp/Sources/CodexRemoteApp/main.swift"), "utf8");
const buildScript = readFileSync(join(root, "scripts/build-macos-app.sh"), "utf8");
const gatewayLauncher = readFileSync(join(root, "scripts/launch-bundled-gateway.sh"), "utf8");

describe("native installer contract", () => {
  it("uses an interactive tty and stable checksum-verified release assets", () => {
    expect(installer).toContain("</dev/tty");
    expect(installer).toContain('"$BASE_URL/$ASSET.sha256"');
    expect(installer).toContain("shasum -a 256 -c");
    expect(installer).toContain("uname -m");
    expect(installer).toContain('arm64|x86_64) ASSET="Codex-Remote-$machine_arch.dmg"');
    expect(installer).toContain("Select the connection method");
    expect(installer).toContain("ConnectionMode");
  });

  it("packages a verified tunnel helper without enabling public mode by default", () => {
    const fetchTunnel = readFileSync(join(root, "scripts/fetch-cloudflared.sh"), "utf8");
    expect(fetchTunnel).toContain("api.github.com/repos/cloudflare/cloudflared/releases/latest");
    expect(fetchTunnel).toContain("digest");
    expect(fetchTunnel).toContain("shasum -a 256");
    expect(fetchTunnel).toContain("--retry 5 --retry-all-errors");
    expect(fetchTunnel).toContain("--connect-timeout 20");
    expect(appSource).toContain('"ConnectionMode"] as? String) == "public"');
    expect(appSource).toContain("trycloudflare\\.com");
    expect(appSource).toContain("Public HTTPS disconnected; retrying");
    expect(appSource).toContain("tunnelDidExit");
  });

  it("creates one-time pairing QR codes without embedding the password", () => {
    expect(appSource).toContain("/api/mobile/pairing");
    expect(appSource).toContain("CIQRCodeGenerator");
  });

  it("retains the pairing panel until the user closes it", () => {
    const temporary = mkdtempSync(join(tmpdir(), "codex-remote-pairing-panel-"));
    const binary = join(temporary, "pairing-panel-lifetime-test");
    try {
      execFileSync("swiftc", [
        "-parse-as-library",
        join(root, "macos/CodexRemoteApp/Sources/CodexRemoteApp/PairingPanelRetainer.swift"),
        join(root, "scripts/pairing-panel-lifetime.test.swift"),
        "-o",
        binary,
      ]);
      execFileSync(binary);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 20_000);

  it("never puts the password in launch agents or command arguments", () => {
    expect(agents).not.toMatch(/token|password|CODEX_WEB_TOKEN/i);
    expect(installer).toContain('chmod 600 "$support/token"');
  });

  it("starts at login without relaunching a deliberately closed menu app", () => {
    expect(agents).toContain("RunAtLoad");
    expect(agents).toContain('render "$APP_PLIST" local.codex-remote.app false');
    expect(agents).toContain('render "$DESKTOP_PLIST" local.codex-remote.desktop true');
    expect(`${installer}\n${agents}`).not.toMatch(/launchctl\s+submit/);
  });

  it("removes pre-rename launch agents that can keep relaunching ChatGPT", () => {
    expect(agents).toContain("local.codex-web.desktop local.codex-web.gateway");
    expect(agents).toContain('bootout "$DOMAIN/$legacy_label"');
    expect(agents).toContain('/bin/rm -f "$AGENTS/$legacy_label.plist"');
  });

  it("replaces only a stale bundled gateway process after an app restart", () => {
    expect(gatewayLauncher).toContain("CODEX_REMOTE_GATEWAY_PID_FILE");
    expect(gatewayLauncher).toContain('"$RESOURCES/gateway/index.mjs"');
    expect(gatewayLauncher).toContain("kill -TERM");
  });

  it("ships executable install and packaging scripts", () => {
    for (const file of ["install.sh", "scripts/build-macos-app.sh", "scripts/package-macos-dmg.sh"]) {
      expect(statSync(join(root, file)).mode & 0o111).not.toBe(0);
    }
  });

  it("uses the original monochrome connection mark instead of opaque app artwork in the menu bar", () => {
    expect(appSource).toContain("menuBarIcon()");
    expect(appSource).toContain("menuIcon?.isTemplate = true");
    expect(appSource).not.toContain("dot.radiowaves.right");
    expect(appSource).not.toContain("MenuIcon.png");
    expect(buildScript).not.toContain("MenuIcon.png");
  });

  it("provides createRequire to bundled CommonJS dependencies without losing ESM top-level await", () => {
    expect(buildScript).toContain("--format=esm");
    expect(buildScript).toContain("createRequire(import.meta.url)");
    expect(buildScript).toContain('outfile="$OUTPUT/gateway.mjs"');
    expect(gatewayLauncher).toContain('"$RESOURCES/gateway/index.mjs"');
  });

  it("opens the Remote Web page when the running Dock app is clicked", () => {
    expect(appSource).toContain("applicationShouldHandleReopen");
    expect(appSource).toContain("openBrowser()");
  });

  it("ships an in-app rollback updater instead of only opening Releases", () => {
    const updateSource = readFileSync(join(root, "macos/CodexRemoteApp/Sources/CodexRemoteApp/UpdateSupport.swift"), "utf8");
    const updateScript = readFileSync(join(root, "scripts/perform-macos-update.sh"), "utf8");
    expect(appSource).toContain("updateController.checkAndInstall()");
    expect(updateSource).toContain("checksumMismatch");
    expect(updateSource).toContain("codesign");
    expect(updateSource).toContain("currentArchitecture()");
    expect(updateScript).toContain("restored previous app");
    expect(buildScript).toContain("perform-macos-update.sh");
  });
});
