import { describe, expect, it, vi } from "vitest";
import { findMobileUpdate } from "./app-update";

describe("findMobileUpdate", () => {
  it("selects the Android APK from a newer GitHub release", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tag_name: "v0.4.2",
        html_url: "https://github.com/cnwenf/codex-remote/releases/tag/v0.4.2",
        assets: [
          { name: "Codex-Remote-android-arm64.apk", browser_download_url: "https://github.com/example/app.apk" },
          { name: "Codex-Remote-android-arm64.apk.sha256", browser_download_url: "https://github.com/example/app.apk.sha256" },
          { name: "Codex-Remote-iOS-unsigned.ipa", browser_download_url: "https://example.test/app.ipa" },
        ],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        object: { sha: "0123456789abcdef0123456789abcdef01234567" },
      }), { status: 200 }));

    await expect(findMobileUpdate("0.4.1", "android", fetcher)).resolves.toEqual({
      state: "available",
      latestVersion: "0.4.2",
      downloadUrl: "https://cdn.jsdelivr.net/gh/cnwenf/codex-remote@0123456789abcdef0123456789abcdef01234567/v0.4.2/Codex-Remote-android-arm64.apk",
      checksumUrl: "https://cdn.jsdelivr.net/gh/cnwenf/codex-remote@0123456789abcdef0123456789abcdef01234567/v0.4.2/Codex-Remote-android-arm64.apk.sha256",
    });
  });

  it("rejects an Android release when the immutable download commit cannot be resolved", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tag_name: "v0.4.2",
        html_url: "https://github.com/cnwenf/codex-remote/releases/tag/v0.4.2",
        assets: [
          { name: "Codex-Remote-android-arm64.apk", browser_download_url: "https://github.com/example/app.apk" },
          { name: "Codex-Remote-android-arm64.apk.sha256", browser_download_url: "https://github.com/example/app.apk.sha256" },
        ],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));

    await expect(findMobileUpdate("0.4.1", "android", fetcher)).rejects.toThrow("update-download-ref-failed:404");
  });

  it("rejects an Android release that does not publish a checksum beside the APK", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      tag_name: "v0.4.2",
      html_url: "https://github.com/cnwenf/codex-remote/releases/tag/v0.4.2",
      assets: [
        { name: "Codex-Remote-android-arm64.apk", browser_download_url: "https://example.test/app.apk" },
      ],
    }), { status: 200 }));

    await expect(findMobileUpdate("0.4.1", "android", fetcher)).rejects.toThrow("update-checksum-invalid");
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
