import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const macosUpdater = readFileSync(join(root, "scripts/perform-macos-update.sh"), "utf8");

describe("native installer contract", () => {
  it("keeps Android and iOS package versions aligned with the release version", () => {
    const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
    const androidBuild = readFileSync(join(root, "android/app/build.gradle"), "utf8");
    const iosProject = readFileSync(join(root, "ios/App/App.xcodeproj/project.pbxproj"), "utf8");

    expect(androidBuild).toContain(`versionName "${packageVersion}"`);
    expect(iosProject).toContain(`MARKETING_VERSION = ${packageVersion};`);
  });

  it("uses an interactive tty and stable checksum-verified release assets", () => {
    expect(installer).toContain("</dev/tty");
    expect(installer).toContain('"$BASE_URL/$ASSET.sha256"');
    expect(installer).toContain("shasum -a 256 -c");
    expect(installer).toContain("uname -m");
    expect(installer).toContain('arm64|x86_64) ASSET="Codex-Remote-$machine_arch.dmg"');
    expect(installer).toContain("Select the connection method");
    expect(installer).toContain("ConnectionMode");
  });

  it("publishes Android upgrades with one stable release signing identity", () => {
    const releaseWorkflow = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
    const androidBuild = readFileSync(join(root, "android/app/build.gradle"), "utf8");
    const signingVerifier = readFileSync(join(root, "scripts/verify-android-signing.sh"), "utf8");

    expect(releaseWorkflow).toContain("ANDROID_RELEASE_KEYSTORE_BASE64");
    expect(releaseWorkflow).toContain("ANDROID_RELEASE_KEYSTORE_PASSWORD");
    expect(releaseWorkflow).toContain("ANDROID_RELEASE_KEY_ALIAS");
    expect(releaseWorkflow).toContain("ANDROID_RELEASE_KEY_PASSWORD");
    expect(releaseWorkflow).toContain("assembleRelease");
    expect(releaseWorkflow).toContain("verify-android-signing.sh");
    expect(releaseWorkflow).not.toContain("assembleDebug");
    expect(releaseWorkflow).not.toContain("app-debug.apk");
    expect(releaseWorkflow).toContain("android-download");
    expect(releaseWorkflow).toContain("Codex-Remote-android-arm64.apk.sha256");
    expect(releaseWorkflow).toContain("gh release view");
    expect(releaseWorkflow).toContain("gh release upload");
    expect(releaseWorkflow).toContain("--clobber");
    expect(releaseWorkflow).toContain("purge.jsdelivr.net");

    expect(androidBuild).toContain("ANDROID_RELEASE_KEYSTORE_PATH");
    expect(androidBuild).toContain("signingConfig signingConfigs.release");
    expect(signingVerifier).toContain("verify --print-certs");
    expect(signingVerifier).toContain("android/release-signing-cert.sha256");
  });

  it("grants the system package installer access to the verified APK on OEM Android builds", () => {
    const nativePlugin = readFileSync(join(root, "android/app/src/main/java/com/cnwenf/codexremote/CodexRemoteNativePlugin.java"), "utf8");
    expect(nativePlugin).toContain("ClipData.newRawUri");
    expect(nativePlugin).toContain("queryIntentActivities");
    expect(nativePlugin).toContain("grantUriPermission");
  });

  it("accepts only the pinned Android signing certificate", () => {
    const fixture = mkdtempSync(join(tmpdir(), "codex-remote-android-signing."));
    const apk = join(fixture, "app.apk");
    const fingerprint = join(fixture, "fingerprint.sha256");
    const fakeApksigner = join(fixture, "apksigner");
    const fakeOpenssl = join(fixture, "openssl");
    const expected = "a".repeat(64);

    try {
      writeFileSync(apk, "fixture");
      writeFileSync(fingerprint, `${expected}\n`);
      writeFileSync(fakeApksigner, `#!/bin/sh
if printf '%s\\n' "$*" | grep -q -- '--print-certs-pem'; then
  printf '%s\\n' '-----BEGIN CERTIFICATE-----' 'fixture' '-----END CERTIFICATE-----'
elif [ "\${FAKE_ANDROID_CERT_USE_PEM:-0}" != 1 ]; then
  printf '  Signer #1 Certificate sha256 fingerprint: %s\\n' "$(printf '%s' "$FAKE_ANDROID_CERT" | sed 's/../&:/g;s/:$//')" >&2
fi
`);
      writeFileSync(fakeOpenssl, `#!/bin/sh
cat >/dev/null
printf 'sha256 Fingerprint=%s\\n' "$(printf '%s' "$FAKE_ANDROID_CERT" | sed 's/../&:/g;s/:$//')"
`);
      chmodSync(fakeApksigner, 0o755);
      chmodSync(fakeOpenssl, 0o755);

      expect(execFileSync("/bin/bash", [join(root, "scripts/verify-android-signing.sh"), apk, fingerprint], {
        env: { ...process.env, APKSIGNER_BIN: fakeApksigner, FAKE_ANDROID_CERT: expected },
        encoding: "utf8",
      })).toContain(expected);
      expect(execFileSync("/bin/bash", [join(root, "scripts/verify-android-signing.sh"), apk, fingerprint], {
        env: {
          ...process.env,
          APKSIGNER_BIN: fakeApksigner,
          OPENSSL_BIN: fakeOpenssl,
          FAKE_ANDROID_CERT: expected,
          FAKE_ANDROID_CERT_USE_PEM: "1",
        },
        encoding: "utf8",
      })).toContain(expected);
      expect(() => execFileSync("/bin/bash", [join(root, "scripts/verify-android-signing.sh"), apk, fingerprint], {
        env: { ...process.env, APKSIGNER_BIN: fakeApksigner, FAKE_ANDROID_CERT: "b".repeat(64) },
        stdio: "pipe",
      })).toThrow();
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("packages a verified tunnel helper without enabling public mode by default", () => {
    const fetchTunnel = readFileSync(join(root, "scripts/fetch-cloudflared.sh"), "utf8");
    const releaseWorkflow = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
    expect(fetchTunnel).toContain("api.github.com/repos/cloudflare/cloudflared/releases/latest");
    expect(fetchTunnel).toContain("digest");
    expect(fetchTunnel).toContain("shasum -a 256");
    expect(fetchTunnel).toContain("--retry 5 --retry-all-errors");
    expect(fetchTunnel).toContain("--connect-timeout 20");
    expect(fetchTunnel).toContain('API_CURL_OPTIONS+=(--header "Authorization: Bearer $GH_TOKEN")');
    expect(fetchTunnel).toMatch(/curl "\$\{API_CURL_OPTIONS\[@\]\}"[\s\S]*api\.github\.com\/repos\/cloudflare\/cloudflared\/releases\/latest/);
    expect(fetchTunnel).toMatch(/curl "\$\{CURL_OPTIONS\[@\]\}" "\$url"/);
    expect(releaseWorkflow).toMatch(/Fetch verified public HTTPS helper[\s\S]*env:\s*\n\s+GH_TOKEN: \$\{\{ github\.token \}\}/);
    expect(appSource).toContain('"ConnectionMode"] as? String) == "public"');
    expect(appSource).toContain("trycloudflare\\.com");
    expect(appSource).toContain("Public HTTPS disconnected; retrying");
    expect(appSource).toContain("tunnelDidExit");
  });

  it("renders one-time pairing QR codes inside the management window without embedding the password", () => {
    expect(appSource).toContain("/api/mobile/pairing");
    expect(appSource).toContain("CIQRCodeGenerator");
    expect(appSource).toContain("pairingImageView.image = image");
    expect(appSource).toContain("pairingPlaceholder.isHidden = true");
    expect(appSource).not.toContain("NSPanel(contentRect:");
  });

  it("keeps every Remote setting and action on one native management page", () => {
    expect(appSource).toContain('labelWithString: "Current access address"');
    expect(appSource).toContain('title: "Copy"');
    expect(appSource).toContain('title: "Open Remote"');
    expect(appSource).toContain('labelWithString: "Connection"');
    expect(appSource).toContain('labelWithString: "Authentication token"');
    expect(appSource).toContain('title: "Get Link QR Code"');
    expect(appSource).toContain('title: "Check for Updates"');
    expect(appSource).toContain('labelWithString: "Desktop bridge"');
    expect(appSource).toContain('title: "Restart Desktop"');
    expect(appSource).toContain("restart-codex-desktop.sh");
  });

  it("reports the packaged version reliably before an in-place update is accepted", () => {
    expect(buildScript).toContain('print "$VERSION" > "$RES/VERSION"');
    expect(buildScript).toContain("CFBundlePackageType");
    expect(appSource).toContain('appendingPathComponent("VERSION")');
    expect(appSource).toContain("bundledVersion()")
    expect(appSource).not.toContain('?? "0.0.0"');
    expect(macosUpdater).toContain('backup="$work/Codex Remote.previous"');
    expect(macosUpdater).toContain('staged_payload="$work/Codex Remote.staged"');
    expect(macosUpdater).toContain('mv "$staged_app" "$staged_payload"');
    expect(macosUpdater).toContain('installed_executable="$current_app/Contents/MacOS/Codex Remote"');
    expect(macosUpdater).toContain('nohup "$installed_executable"');
    expect(macosUpdater).not.toContain('/usr/bin/open -n "$current_app"');
    expect(macosUpdater).toContain('/usr/bin/pgrep -x "Codex Remote"');
    expect(macosUpdater).not.toContain("Codex Remote.backup.app");
  });

  it("uses an explicit leading-aligned native settings layout instead of ambiguous centered stacks", () => {
    expect(appSource).toContain("width: 820, height: 660");
    expect(appSource).toContain("let root = NSView()");
    expect(appSource).toContain("settingsCard.widthAnchor.constraint(equalTo: root.widthAnchor, multiplier: 0.57");
    expect(appSource).toContain("title.alignment = .left");
    expect(appSource).not.toContain("settingsCard.heightAnchor.constraint(equalTo: pairingCard.heightAnchor)");
  });

  it("never puts the password in launch agents or command arguments", () => {
    expect(agents).not.toMatch(/token|password|CODEX_WEB_TOKEN/i);
    expect(installer).toContain('chmod 600 "$support/token"');
  });

  it("starts at login without keeping either desktop app alive", () => {
    expect(agents).toContain("RunAtLoad");
    expect(agents).toContain('render "$APP_PLIST" local.codex-remote.app false');
    expect(agents).toContain('render "$DESKTOP_PLIST" local.codex-remote.desktop false');
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

  it("starts the Web listener without waiting for the Desktop debug bridge", () => {
    expect(gatewayLauncher).not.toContain("for _ in {1..120}");
    expect(gatewayLauncher).not.toContain('curl -fsS "$CDP_ENDPOINT/json/list"');
    expect(gatewayLauncher).toContain('CODEX_DESKTOP_CDP_ENDPOINT="$CDP_ENDPOINT"');
  });

  it("ships executable install and packaging scripts", () => {
    for (const file of ["install.sh", "scripts/build-macos-app.sh", "scripts/package-macos-dmg.sh", "scripts/create-macos-dmg.sh", "scripts/restart-codex-desktop.sh"]) {
      expect(statSync(join(root, file)).mode & 0o111).not.toBe(0);
    }
  });

  it("retries a transient hdiutil resource-busy failure before publishing the DMG", () => {
    const fixture = mkdtempSync(join(tmpdir(), "codex-remote-dmg-test."));
    const staging = join(fixture, "staging");
    const target = join(fixture, "Codex-Remote-arm64.dmg");
    const counter = join(fixture, "attempts");
    const fakeHdiutil = join(fixture, "hdiutil");

    try {
      writeFileSync(
        fakeHdiutil,
        `#!/bin/zsh
count=0
[[ -f "$CODEX_REMOTE_TEST_COUNTER" ]] && count=$(<"$CODEX_REMOTE_TEST_COUNTER")
count=$((count + 1))
print "$count" > "$CODEX_REMOTE_TEST_COUNTER"
if [[ "$count" == "1" ]]; then
  print -u2 "hdiutil: create failed - Resource busy"
  exit 1
fi
touch "\${@: -1}"
`,
      );
      chmodSync(fakeHdiutil, 0o755);
      execFileSync("/bin/mkdir", ["-p", staging]);

      execFileSync("/bin/zsh", [join(root, "scripts/create-macos-dmg.sh"), staging, target], {
        env: {
          ...process.env,
          CODEX_REMOTE_HDIUTIL_BIN: fakeHdiutil,
          CODEX_REMOTE_DMG_RETRY_DELAY_SECONDS: "0",
          CODEX_REMOTE_TEST_COUNTER: counter,
        },
      });

      expect(readFileSync(counter, "utf8").trim()).toBe("2");
      expect(statSync(target).isFile()).toBe(true);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("derives the monochrome menu-bar glyph from the same application icon artwork", () => {
    expect(appSource).toContain("menuBarIcon()");
    expect(appSource).toContain("menuIcon?.isTemplate = true");
    const menuBarIcon = appSource.match(
      /private func menuBarIcon\(\)[\s\S]*?\n  \}\n\n  private func appBrandIcon/,
    )?.[0] ?? "";
    expect(menuBarIcon).toContain("NSApplication.shared.applicationIconImage");
    expect(menuBarIcon).toContain("alphaFromApplicationIcon");
    expect(menuBarIcon).not.toContain("connectionMarkPaths");
  });

  it("provides createRequire to bundled CommonJS dependencies without losing ESM top-level await", () => {
    expect(buildScript).toContain("--format=esm");
    expect(buildScript).toContain("createRequire(import.meta.url)");
    expect(buildScript).toContain('outfile="$OUTPUT/gateway.mjs"');
    expect(gatewayLauncher).toContain('"$RESOURCES/gateway/index.mjs"');
  });

  it("opens the native management window when the running Dock app is clicked", () => {
    const reopenHandler = appSource.match(
      /func applicationShouldHandleReopen[\s\S]*?\{([\s\S]*?)\n  \}/,
    )?.[1];

    expect(reopenHandler).toContain("showSettings()\n");
    expect(reopenHandler).not.toContain("openBrowser()\n");
  });

  it("opens the management window on a cold user launch but stays hidden at login", () => {
    expect(agents).toContain("CODEX_REMOTE_BACKGROUND_LAUNCH");
    expect(appSource).toContain('environment["CODEX_REMOTE_BACKGROUND_LAUNCH"] != "1"');
    expect(appSource).toContain("showSettings()\n");
  });

  it("opens the management window without automatically focusing the private IP field", () => {
    const showSettings = appSource.match(
      /@objc private func showSettings\(\)[\s\S]*?\n  \}/,
    )?.[0] ?? "";

    expect(showSettings).toContain("window.makeKeyAndOrderFront(nil)");
    expect(showSettings).toContain("window.makeFirstResponder(nil)");
    expect(showSettings).not.toContain("hostField.becomeFirstResponder");
    expect(appSource).not.toContain("hostField.refusesFirstResponder = true");
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
