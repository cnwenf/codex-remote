import { describe, expect, it, vi } from "vitest";
import { findMobileUpdate } from "./app-update";

describe("findMobileUpdate", () => {
  it("selects the immutable Android APK from the release manifest without calling GitHub API", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      version: "0.4.2",
      androidDownloadCommit: "0123456789abcdef0123456789abcdef01234567",
    }), { status: 200 }));

    await expect(findMobileUpdate("0.4.1", "android", fetcher)).resolves.toEqual({
      state: "available",
      latestVersion: "0.4.2",
      downloadUrl: "https://cdn.jsdelivr.net/gh/cnwenf/codex-remote@0123456789abcdef0123456789abcdef01234567/v0.4.2/Codex-Remote-android-arm64.apk",
      checksumUrl: "https://cdn.jsdelivr.net/gh/cnwenf/codex-remote@0123456789abcdef0123456789abcdef01234567/v0.4.2/Codex-Remote-android-arm64.apk.sha256",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      "https://cdn.jsdelivr.net/gh/cnwenf/codex-remote@android-download/latest.json",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("rejects an Android release when the manifest has no immutable download commit", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ version: "0.4.2" }), { status: 200 }));

    await expect(findMobileUpdate("0.4.1", "android", fetcher)).rejects.toThrow("update-download-ref-invalid");
  });

  it("reports the current release as up to date", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      version: "0.4.1",
      androidDownloadCommit: "0123456789abcdef0123456789abcdef01234567",
    }), { status: 200 }));

    await expect(findMobileUpdate("0.4.1", "ios", fetcher)).resolves.toEqual({ state: "current" });
  });

  it("opens the release page for iPhone because the published IPA is unsigned", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      version: "0.4.2",
      androidDownloadCommit: "0123456789abcdef0123456789abcdef01234567",
    }), { status: 200 }));

    await expect(findMobileUpdate("0.4.1", "ios", fetcher)).resolves.toEqual({
      state: "available",
      latestVersion: "0.4.2",
      downloadUrl: "https://github.com/cnwenf/codex-remote/releases/tag/v0.4.2",
    });
  });
});
