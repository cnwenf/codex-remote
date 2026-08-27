export type MobilePlatform = "android" | "ios";

export type MobileUpdateStatus =
  | { state: "idle" | "checking" | "current" }
  | ({ state: "available" } & MobileUpdateArtifact)
  | { state: "downloading"; latestVersion: string; progress: number }
  | { state: "installing"; latestVersion: string }
  | { state: "error"; message: string };

export type MobileUpdateArtifact = {
  latestVersion: string;
  downloadUrl: string;
  checksumUrl?: string;
};

type MobileReleaseManifest = {
  version?: unknown;
  androidDownloadCommit?: unknown;
};

const latestManifestUrls = [
  "https://github.com/cnwenf/codex-remote/releases/latest/download/latest.json",
  "https://raw.githubusercontent.com/cnwenf/codex-remote/android-download/latest.json",
  "https://cdn.jsdelivr.net/gh/cnwenf/codex-remote@android-download/latest.json",
];
const androidDownloadRoot = "https://cdn.jsdelivr.net/gh/cnwenf/codex-remote";
const githubReleaseRoot = "https://github.com/cnwenf/codex-remote/releases/tag";

export async function findMobileUpdate(
  currentVersion: string,
  platform: MobilePlatform,
  fetcher: typeof fetch = fetch,
): Promise<MobileUpdateStatus> {
  const manifest = await fetchReleaseManifest(fetcher, platform);
  const latestVersion = typeof manifest.version === "string" ? manifest.version.replace(/^v/, "") : "";
  if (!latestVersion) throw new Error("update-release-invalid");
  if (compareVersions(latestVersion, currentVersion) <= 0) return { state: "current" };

  if (platform === "android") {
    const downloadCommit = typeof manifest.androidDownloadCommit === "string"
      ? manifest.androidDownloadCommit
      : "";
    if (!/^[0-9a-f]{40}$/i.test(downloadCommit)) throw new Error("update-download-ref-invalid");
    const immutableDownloadRoot = `${androidDownloadRoot}@${downloadCommit}`;
    const releaseTag = `v${latestVersion}`;
    const assetName = "Codex-Remote-android-arm64.apk";
    return {
      state: "available",
      latestVersion,
      downloadUrl: `${immutableDownloadRoot}/${encodeURIComponent(releaseTag)}/${encodeURIComponent(assetName)}`,
      checksumUrl: `${immutableDownloadRoot}/${encodeURIComponent(releaseTag)}/${encodeURIComponent(assetName)}.sha256`,
    };
  }
  return {
    state: "available",
    latestVersion,
    downloadUrl: `${githubReleaseRoot}/v${encodeURIComponent(latestVersion)}`,
  };
}

async function fetchReleaseManifest(fetcher: typeof fetch, platform: MobilePlatform) {
  let lastError = new Error("update-check-failed");
  for (const url of latestManifestUrls) {
    try {
      const response = await fetcher(url, { cache: "no-store" });
      if (!response.ok) {
        lastError = new Error(`update-check-failed:${response.status}`);
        continue;
      }
      const manifest = await response.json() as MobileReleaseManifest;
      if (typeof manifest.version !== "string" || !/^v?\d+\.\d+\.\d+$/.test(manifest.version)) {
        lastError = new Error("update-release-invalid");
        continue;
      }
      if (platform === "android"
        && (typeof manifest.androidDownloadCommit !== "string"
          || !/^[0-9a-f]{40}$/i.test(manifest.androidDownloadCommit))) {
        lastError = new Error("update-download-ref-invalid");
        continue;
      }
      return manifest;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("update-check-failed");
    }
  }
  throw lastError;
}

function compareVersions(left: string, right: string) {
  const leftParts = numericParts(left);
  const rightParts = numericParts(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function numericParts(version: string) {
  return version.split(".").map((part) => Number.parseInt(part, 10) || 0);
}
