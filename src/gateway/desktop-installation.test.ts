import { describe, expect, it } from "vitest";
import { inspectDesktopInstallation } from "./desktop-installation";

describe("inspectDesktopInstallation", () => {
  it("discovers the signed app, renderer bundle, and bundled codex binary", () => {
    const root = "/Applications/ChatGPT.app";
    const files = new Map([
      [`${root}/Contents/Info.plist`, `
        <plist><dict>
          <key>CFBundleIdentifier</key><string>com.openai.codex</string>
          <key>CFBundleShortVersionString</key><string>1.2026.224</string>
        </dict></plist>`],
    ]);
    const paths = new Set([
      root,
      `${root}/Contents/Info.plist`,
      `${root}/Contents/Resources/app.asar`,
      `${root}/Contents/Resources/codex`,
    ]);

    expect(inspectDesktopInstallation({
      appPath: root,
      exists: (path) => paths.has(path),
      readText: (path) => files.get(path) ?? "",
    })).toEqual({
      appPath: root,
      appVersion: "1.2026.224",
      bundleIdentifier: "com.openai.codex",
      appAsarPath: `${root}/Contents/Resources/app.asar`,
      codexBinaryPath: `${root}/Contents/Resources/codex`,
    });
  });

  it("rejects an app with an unexpected bundle identifier", () => {
    expect(() => inspectDesktopInstallation({
      appPath: "/tmp/Fake.app",
      exists: () => true,
      readText: () => "<key>CFBundleIdentifier</key><string>example.fake</string>",
    })).toThrow("desktop-bundle-identifier-mismatch");
  });

  it("fails when the renderer bundle is missing", () => {
    expect(() => inspectDesktopInstallation({
      appPath: "/Applications/ChatGPT.app",
      exists: (path) => !path.endsWith("app.asar"),
      readText: () => "<key>CFBundleIdentifier</key><string>com.openai.codex</string>",
    })).toThrow("desktop-renderer-bundle-missing");
  });
});
