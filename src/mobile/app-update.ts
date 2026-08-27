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

const latestManifestUrl = "https://cdn.jsdelivr.net/gh/cnwenf/codex-remote@android-download/latest.json";
const androidDownloadRoot = "https://cdn.jsdelivr.net/gh/cnwenf/codex-remote";
const githubReleaseRoot = "https://github.com/cnwenf/codex-remote/releases/tag";

export async function findMobileUpdate(
  currentVersion: string,
  platform: MobilePlatform,
  fetcher: typeof fetch = fetch,
): Promise<MobileUpdateStatus> {
  const response = await fetcher(latestManifestUrl, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`update-check-failed:${response.status}`);
  const manifest = await response.json() as MobileReleaseManifest;
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
