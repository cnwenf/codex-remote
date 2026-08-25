import { describe, expect, it, vi } from "vitest";
import { findMobileUpdate } from "./app-update";

describe("findMobileUpdate", () => {
  it("selects the Android APK from a newer GitHub release", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      tag_name: "v0.4.2",
      html_url: "https://github.com/cnwenf/codex-remote/releases/tag/v0.4.2",
      assets: [
        { name: "Codex-Remote-android-arm64.apk", browser_download_url: "https://example.test/app.apk" },
        { name: "Codex-Remote-iOS-unsigned.ipa", browser_download_url: "https://example.test/app.ipa" },
      ],
    }), { status: 200 }));

    await expect(findMobileUpdate("0.4.1", "android", fetcher)).resolves.toEqual({
      state: "available",
      latestVersion: "0.4.2",
      downloadUrl: "https://example.test/app.apk",
    });
  });

  it("reports the current release as up to date", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      tag_name: "v0.4.1",
      html_url: "https://github.com/cnwenf/codex-remote/releases/tag/v0.4.1",
      assets: [],
    }), { status: 200 }));

    await expect(findMobileUpdate("0.4.1", "ios", fetcher)).resolves.toEqual({ state: "current" });
  });

  it("opens the release page for iPhone because the published IPA is unsigned", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      tag_name: "v0.4.2",
      html_url: "https://github.com/cnwenf/codex-remote/releases/tag/v0.4.2",
      assets: [
        { name: "Codex-Remote-iOS-unsigned.ipa", browser_download_url: "https://example.test/app.ipa" },
      ],
    }), { status: 200 }));

    await expect(findMobileUpdate("0.4.1", "ios", fetcher)).resolves.toEqual({
      state: "available",
      latestVersion: "0.4.2",
      downloadUrl: "https://github.com/cnwenf/codex-remote/releases/tag/v0.4.2",
    });
  });
});
