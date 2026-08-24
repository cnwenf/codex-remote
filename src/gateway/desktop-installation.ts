import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_DESKTOP_APP_PATH = "/Applications/ChatGPT.app";
const EXPECTED_BUNDLE_IDENTIFIER = "com.openai.codex";

export type DesktopInstallation = {
  appPath: string;
  appVersion?: string;
  bundleIdentifier: string;
  appAsarPath: string;
  codexBinaryPath: string;
};

type InspectionOptions = {
  appPath?: string;
  exists?: (path: string) => boolean;
  readText?: (path: string) => string;
};

export function inspectDesktopInstallation(
  options: InspectionOptions = {},
): DesktopInstallation {
  const appPath = options.appPath ?? DEFAULT_DESKTOP_APP_PATH;
  const exists = options.exists ?? existsSync;
  const readText = options.readText ?? ((path: string) => readFileSync(path, "utf8"));
  const infoPath = join(appPath, "Contents", "Info.plist");
  const appAsarPath = join(appPath, "Contents", "Resources", "app.asar");
  const codexBinaryPath = join(appPath, "Contents", "Resources", "codex");

  if (!exists(appPath) || !exists(infoPath)) {
    throw new Error("desktop-installation-missing");
  }
  const plist = readText(infoPath);
  const bundleIdentifier = readPlistString(plist, "CFBundleIdentifier");
  if (bundleIdentifier !== EXPECTED_BUNDLE_IDENTIFIER) {
    throw new Error("desktop-bundle-identifier-mismatch");
  }
  if (!exists(appAsarPath)) throw new Error("desktop-renderer-bundle-missing");
  if (!exists(codexBinaryPath)) throw new Error("desktop-codex-binary-missing");

  const appVersion = readPlistString(plist, "CFBundleShortVersionString");
  return {
    appPath,
    ...(appVersion ? { appVersion } : {}),
    bundleIdentifier,
    appAsarPath,
    codexBinaryPath,
  };
}
function readPlistString(plist: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = plist.match(
    new RegExp(`<key>\\s*${escapedKey}\\s*</key>\\s*<string>([^<]*)</string>`),
  );
  return match?.[1]?.trim() || undefined;
}
