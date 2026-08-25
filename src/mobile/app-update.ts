export type MobilePlatform = "android" | "ios";

export type MobileUpdateStatus =
  | { state: "idle" | "checking" | "current" }
  | { state: "available"; latestVersion: string; downloadUrl: string }
  | { state: "error"; message: string };

type GitHubRelease = {
  tag_name?: unknown;
  html_url?: unknown;
  assets?: Array<{ name?: unknown; browser_download_url?: unknown }>;
};

const latestReleaseUrl = "https://api.github.com/repos/cnwenf/codex-remote/releases/latest";

export async function findMobileUpdate(
  currentVersion: string,
  platform: MobilePlatform,
  fetcher: typeof fetch = fetch,
): Promise<MobileUpdateStatus> {
  const response = await fetcher(latestReleaseUrl, {
    cache: "no-store",
    headers: { accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`update-check-failed:${response.status}`);
  const release = await response.json() as GitHubRelease;
  const latestVersion = typeof release.tag_name === "string" ? release.tag_name.replace(/^v/, "") : "";
  if (!latestVersion) throw new Error("update-release-invalid");
  if (compareVersions(latestVersion, currentVersion) <= 0) return { state: "current" };

  const asset = platform === "android" ? release.assets?.find((candidate) => (
    typeof candidate.name === "string" && candidate.name.toLowerCase().endsWith(".apk")
  )) : undefined;
  const downloadUrl = platform === "android" && typeof asset?.browser_download_url === "string"
    ? asset.browser_download_url
    : typeof release.html_url === "string" ? release.html_url : "";
  if (!downloadUrl.startsWith("https://")) throw new Error("update-download-invalid");
  return { state: "available", latestVersion, downloadUrl };
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
