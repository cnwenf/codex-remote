import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMobileUpdate: vi.fn(),
  nativePlugin: {
    addListener: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
    getLaunchTarget: vi.fn(async () => ({})),
    startMonitoring: vi.fn(async () => undefined),
  },
}));

vi.mock("../web/app", () => ({
  App: ({ remote }: { remote: { connectionId: string } }) => (
    <main><span data-testid="active-connection">{remote.connectionId}</span></main>
  ),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => "android",
  },
  registerPlugin: () => mocks.nativePlugin,
}));

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
    getInfo: vi.fn(async () => ({ version: "0.5.10" })),
    getLaunchUrl: vi.fn(async () => undefined),
  },
}));

vi.mock("@capacitor/local-notifications", () => ({
  LocalNotifications: {
    addListener: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
  },
}));

vi.mock("./app-update", async (importOriginal) => ({
  ...await importOriginal<typeof import("./app-update")>(),
  findMobileUpdate: mocks.findMobileUpdate,
}));

import { MobileShell } from "./mobile-shell";

describe("MobileShell updates", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it("checks for a new native app version automatically on launch", async () => {
    mocks.findMobileUpdate.mockResolvedValue({
      state: "available",
      latestVersion: "0.5.11",
      downloadUrl: "https://example.test/app.apk",
      checksumUrl: "https://example.test/app.apk.sha256",
    });
    const store = {
      list: vi.fn(async () => []),
      getSelected: vi.fn(async () => undefined),
    };
    const settingsStore = {
      read: vi.fn(async () => ({ theme: "system", language: "zh-CN", messageSendMode: "queue" })),
    };

    const { container } = render(
      <MobileShell storeOverride={store as never} settingsStoreOverride={settingsStore as never} />,
    );

    await waitFor(() => expect(mocks.findMobileUpdate).toHaveBeenCalledWith("0.5.10", "android"));
    expect(container.querySelector(".mobile-update-available-dot")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(await screen.findByText("v0.5.10")).toBeVisible();
  });

  it("keeps the last clicked connection active when credential reads finish out of order", async () => {
    const office = { id: "mac-1", name: "Office Mac", baseUrl: "http://127.0.0.1:4318", lastUsedAt: 2, pairingStatus: "ready" as const };
    const home = { id: "mac-2", name: "Home Mac", baseUrl: "http://127.0.0.1:4319", lastUsedAt: 1, pairingStatus: "ready" as const };
    const officeCredentials = deferred<{ connection: typeof office; token: string }>();
    const homeCredentials = deferred<{ connection: typeof home; token: string }>();
    const store = {
      list: vi.fn(async () => [office, home]),
      getSelected: vi.fn(async () => undefined),
      credentials: vi.fn((id: string) => id === office.id ? officeCredentials.promise : homeCredentials.promise),
      select: vi.fn(async () => undefined),
    };
    const settingsStore = {
      read: vi.fn(async () => ({ theme: "system", language: "zh-CN", messageSendMode: "queue" })),
    };

    render(<MobileShell storeOverride={store as never} settingsStoreOverride={settingsStore as never} />);
    await userEvent.click(await screen.findByRole("button", { name: /Office Mac/ }));
    await userEvent.click(screen.getByRole("button", { name: /Home Mac/ }));

    await act(async () => homeCredentials.resolve({ connection: home, token: "home-token" }));
    await act(async () => officeCredentials.resolve({ connection: office, token: "office-token" }));

    expect(await screen.findByTestId("active-connection")).toHaveTextContent(home.id);
    expect(store.select).toHaveBeenCalledTimes(1);
    expect(store.select).toHaveBeenCalledWith(home.id);
    expect(mocks.nativePlugin.startMonitoring).toHaveBeenCalledWith(expect.objectContaining({ connectionId: home.id }));
    expect(mocks.nativePlugin.startMonitoring).not.toHaveBeenCalledWith(expect.objectContaining({ connectionId: office.id }));
  });

  it("opens on the connection list and checks saved connections without auto-opening the last one", async () => {
    mocks.findMobileUpdate.mockResolvedValue({ state: "current" });
    const office = { id: "mac-1", name: "Office Mac", baseUrl: "http://127.0.0.1:4318", lastUsedAt: 2, pairingStatus: "ready" as const };
    const home = { id: "mac-2", name: "Home Mac", baseUrl: "http://127.0.0.1:4319", lastUsedAt: 1, pairingStatus: "ready" as const };
    const store = {
      list: vi.fn(async () => [office, home]),
      getSelected: vi.fn(async () => office),
      credentials: vi.fn(async (id: string) => ({
        connection: id === office.id ? office : home,
        token: `${id}-token`,
      })),
      select: vi.fn(async () => undefined),
    };
    const settingsStore = {
      read: vi.fn(async () => ({ theme: "system", language: "zh-CN", messageSendMode: "queue" })),
    };
    const fetchStatus = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ version: 1, generatedAt: 1, threads: [] }), { status: 200 }),
    );

    render(<MobileShell storeOverride={store as never} settingsStoreOverride={settingsStore as never} />);

    await waitFor(() => expect(fetchStatus).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("heading", { name: "选择一台 Mac" })).toBeVisible();
    expect(screen.queryByTestId("active-connection")).not.toBeInTheDocument();
    expect(store.getSelected).not.toHaveBeenCalled();
    expect(store.select).not.toHaveBeenCalled();
  });

  it("marks a stalled connection unavailable after a bounded status check", async () => {
    vi.useFakeTimers();
    mocks.findMobileUpdate.mockResolvedValue({ state: "current" });
    const connection = { id: "mac-1", name: "Office Mac", baseUrl: "http://127.0.0.1:4318", lastUsedAt: 1, pairingStatus: "ready" as const };
    const store = {
      list: vi.fn(async () => [connection]),
      credentials: vi.fn(async () => ({ connection, token: "test-token" })),
    };
    const settingsStore = {
      read: vi.fn(async () => ({ theme: "system", language: "zh-CN", messageSendMode: "queue" })),
    };
    const fetchStatus = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => undefined));

    render(<MobileShell storeOverride={store as never} settingsStoreOverride={settingsStore as never} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(fetchStatus).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("检测中")).toBeVisible();

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByLabelText("不可用")).toBeVisible();
  });

  it("aborts an in-flight connection status check when the shell unmounts", async () => {
    mocks.findMobileUpdate.mockResolvedValue({ state: "current" });
    const connection = { id: "mac-1", name: "Office Mac", baseUrl: "http://127.0.0.1:4318", lastUsedAt: 1, pairingStatus: "ready" as const };
    const store = {
      list: vi.fn(async () => [connection]),
      credentials: vi.fn(async () => ({ connection, token: "test-token" })),
    };
    const settingsStore = {
      read: vi.fn(async () => ({ theme: "system", language: "zh-CN", messageSendMode: "queue" })),
    };
    let requestSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise(() => undefined);
    });

    const view = render(<MobileShell storeOverride={store as never} settingsStoreOverride={settingsStore as never} />);
    await waitFor(() => expect(requestSignal).toBeDefined());
    view.unmount();

    expect(requestSignal?.aborted).toBe(true);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
