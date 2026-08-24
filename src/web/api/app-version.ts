type VersionWatcherOptions = {
  fetcher?: typeof fetch;
  reload?: () => void;
  setInterval?: (callback: () => void, delay: number) => number;
  clearInterval?: (id: number) => void;
};

export function watchAppVersion(options: VersionWatcherOptions = {}) {
  const fetcher = options.fetcher ?? fetch;
  const reload = options.reload ?? (() => window.location.reload());
  const schedule = options.setInterval ?? ((callback, delay) => window.setInterval(callback, delay));
  const cancel = options.clearInterval ?? ((id) => window.clearInterval(id));
  let active = true;
  let currentVersion: string | undefined;
  let checking = false;

  const check = async () => {
    if (!active || checking) return;
    checking = true;
    try {
      const response = await fetcher("/app-version", { cache: "no-store" });
      if (!response.ok) return;
      const value = await response.json() as unknown;
      const version = value && typeof value === "object" && "version" in value
        ? (value as { version?: unknown }).version
        : undefined;
      if (typeof version !== "string" || !version) return;
      if (currentVersion && version !== currentVersion) reload();
      currentVersion = version;
    } catch {
      // Gateway restarts are expected; the next check will retry.
    } finally {
      checking = false;
    }
  };

  void check();
  const timer = schedule(() => { void check(); }, 5_000);
  return () => {
    active = false;
    cancel(timer);
  };
}
