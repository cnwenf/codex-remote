import { describe, expect, it, vi } from "vitest";
import { watchAppVersion } from "./app-version";

describe("watchAppVersion", () => {
  it("reloads only after the running gateway advertises a different Web build", async () => {
    const responses = ["build-a", "build-a", "build-b"];
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: responses.shift() }),
    })) as unknown as typeof fetch;
    const reload = vi.fn();
    let tick: (() => void) | undefined;
    const stop = watchAppVersion({
      fetcher,
      reload,
      setInterval: (callback) => {
        tick = callback;
        return 1;
      },
      clearInterval: vi.fn(),
    });

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    tick?.();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reload).not.toHaveBeenCalled();
    tick?.();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    stop();
  });
});
