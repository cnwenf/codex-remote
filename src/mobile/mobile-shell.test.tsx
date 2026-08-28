import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMobileUpdate: vi.fn(),
  isNativePlatform: vi.fn(() => false),
  capacitorHttpGet: vi.fn(),
  capacitorHttpRequest: vi.fn(),
  imageUploadFailed: vi.fn(),
  imageBody: "image",
  capacitorListeners: new Map<string, (...args: unknown[]) => void>(),
  nativePlugin: {
    addListener: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
    getLaunchTarget: vi.fn(async () => ({})),
    openExternalUrl: vi.fn(async () => undefined),
    startMonitoring: vi.fn(async () => undefined),
    startImageUpload: vi.fn(async () => ({ uploadId: "native-upload-1" })),
    appendImageUpload: vi.fn(async (_options: { data: string }) => undefined),
    finishImageUpload: vi.fn(async () => ({
      status: 201,
      data: { id: "upload-1", name: "screen.png", mimeType: "image/png", size: 5 },
    })),
    cancelImageUpload: vi.fn(async () => undefined),
  },
}));

vi.mock("../web/app", () => ({
  App: ({ remote }: { remote: { connectionId: string; imageUploader?(file: File): Promise<unknown>; onOpenConnection?(id: string): void; onOpenExternalUrl?(url: string): void } }) => (
    <main>
      <span data-testid="active-connection">{remote.connectionId}</span>
      <span data-testid="image-upload-transport">{remote.imageUploader ? "native" : "web"}</span>
      <button type="button" onClick={() => remote.onOpenExternalUrl?.("https://docs.example.test/path")}>Open docs</button>
      <button type="button" onClick={() => remote.onOpenConnection?.("mac-2")}>Switch connection</button>
      <button type="button" onClick={() => void remote.imageUploader?.(
        new File([mocks.imageBody], "screen.png", { type: "image/png" }),
      ).catch(mocks.imageUploadFailed)}>Upload image</button>
    </main>
  ),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => "android",
    isNativePlatform: mocks.isNativePlatform,
  },
  CapacitorHttp: { get: mocks.capacitorHttpGet, request: mocks.capacitorHttpRequest },
  registerPlugin: () => mocks.nativePlugin,
}));

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn(async (event: string, listener: (...args: unknown[]) => void) => {
      mocks.capacitorListeners.set(event, listener);
      return {
        remove: vi.fn(async () => {
          if (mocks.capacitorListeners.get(event) === listener) mocks.capacitorListeners.delete(event);
        }),
      };
    }),
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
    vi.clearAllMocks();
    mocks.isNativePlatform.mockReturnValue(false);
    mocks.imageBody = "image";
    mocks.capacitorListeners.clear();
    window.history.replaceState(null, "");
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

  it("asks before opening a conversation link in the system browser", async () => {
    mocks.findMobileUpdate.mockResolvedValue({ state: "current" });
    const connection = { id: "mac-1", name: "Office Mac", baseUrl: "http://127.0.0.1:4318", lastUsedAt: 1, pairingStatus: "ready" as const };
    const store = {
      list: vi.fn(async () => [connection]),
      credentials: vi.fn(async () => ({ connection, token: "test-token" })),
      select: vi.fn(async () => undefined),
    };
    const settingsStore = {
      read: vi.fn(async () => ({ theme: "system", language: "zh-CN", messageSendMode: "queue" })),
    };
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);

    render(<MobileShell storeOverride={store as never} settingsStoreOverride={settingsStore as never} />);
    await userEvent.click(await screen.findByRole("button", { name: /Office Mac/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Open docs" }));

    expect(confirm).toHaveBeenLastCalledWith("将在浏览器中打开 docs.example.test，是否继续？");
    expect(mocks.nativePlugin.openExternalUrl).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Open docs" }));
    expect(mocks.nativePlugin.openExternalUrl).toHaveBeenCalledWith({ url: "https://docs.example.test/path" });
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

  it("uses native HTTP for connection reachability inside the installed app", async () => {
    mocks.findMobileUpdate.mockResolvedValue({ state: "current" });
    mocks.isNativePlatform.mockReturnValue(true);
    mocks.capacitorHttpGet.mockResolvedValue({
      status: 200,
      data: { version: 1, generatedAt: 1, threads: [] },
      headers: {},
      url: "https://remote.example.test/api/mobile/status",
    });
    const connection = { id: "mac-1", name: "Office Mac", baseUrl: "https://remote.example.test", lastUsedAt: 1, pairingStatus: "ready" as const };
    const store = {
      list: vi.fn(async () => [connection]),
      credentials: vi.fn(async () => ({ connection, token: "test-token" })),
    };
    const settingsStore = {
      read: vi.fn(async () => ({ theme: "system", language: "zh-CN", messageSendMode: "queue" })),
    };
    const webFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("webview-fetch-blocked"));

    render(<MobileShell storeOverride={store as never} settingsStoreOverride={settingsStore as never} />);

    await waitFor(() => expect(mocks.capacitorHttpGet).toHaveBeenCalled());
    expect(await screen.findByLabelText("可用")).toBeVisible();
    expect(mocks.capacitorHttpGet).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://remote.example.test/api/mobile/status",
      headers: { authorization: "Bearer test-token" },
    }));
    expect(webFetch).not.toHaveBeenCalledWith(
      "https://remote.example.test/api/mobile/status",
      expect.anything(),
    );
  });

  it("stages conversation images in bounded native chunks before streaming the upload", async () => {
    mocks.findMobileUpdate.mockResolvedValue({ state: "current" });
    mocks.isNativePlatform.mockReturnValue(true);
    mocks.imageBody = "x".repeat(300_000);
    mocks.capacitorHttpGet.mockResolvedValue({
      status: 200,
      data: { version: 1, generatedAt: 1, threads: [] },
      headers: {},
      url: "https://remote.example.test/api/mobile/status",
    });
    const chunks: Uint8Array[] = [];
    mocks.nativePlugin.appendImageUpload.mockImplementation(async ({ data }: { data: string }) => {
      chunks.push(Uint8Array.from(Buffer.from(data, "base64")));
    });
    const connection = { id: "mac-1", name: "Office Mac", baseUrl: "https://remote.example.test", lastUsedAt: 1, pairingStatus: "ready" as const };
    const store = {
      list: vi.fn(async () => [connection]),
      credentials: vi.fn(async () => ({ connection, token: "test-token" })),
      select: vi.fn(async () => undefined),
    };
    const settingsStore = {
      read: vi.fn(async () => ({ theme: "system", language: "zh-CN", messageSendMode: "queue" })),
    };
    const webFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("webview-fetch-blocked"));

    render(<MobileShell storeOverride={store as never} settingsStoreOverride={settingsStore as never} />);
    await userEvent.click(await screen.findByRole("button", { name: /Office Mac/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Upload image" }));

    await waitFor(() => expect(mocks.nativePlugin.finishImageUpload).toHaveBeenCalledWith({
      uploadId: "native-upload-1",
      url: "https://remote.example.test/api/images",
      token: "test-token",
      fileName: "screen.png",
      mimeType: "image/png",
    }));
    expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString()).toBe(mocks.imageBody);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.byteLength <= 256 * 1024)).toBe(true);
    expect(mocks.capacitorHttpRequest).not.toHaveBeenCalled();
    expect(webFetch).not.toHaveBeenCalled();
  });

  it("stops a native image upload that never settles instead of leaving send busy forever", async () => {
    vi.useFakeTimers();
    mocks.findMobileUpdate.mockResolvedValue({ state: "current" });
    mocks.isNativePlatform.mockReturnValue(true);
    mocks.capacitorHttpGet.mockResolvedValue({ status: 200, data: {}, headers: {}, url: "" });
    mocks.nativePlugin.appendImageUpload.mockImplementation(() => new Promise(() => undefined));
    const connection = { id: "mac-1", name: "Office Mac", baseUrl: "https://remote.example.test", lastUsedAt: 1, pairingStatus: "ready" as const };
    const store = {
      list: vi.fn(async () => [connection]),
      credentials: vi.fn(async () => ({ connection, token: "test-token" })),
      select: vi.fn(async () => undefined),
    };
    const settingsStore = {
      read: vi.fn(async () => ({ theme: "system", language: "zh-CN", messageSendMode: "queue" })),
    };

    render(<MobileShell storeOverride={store as never} settingsStoreOverride={settingsStore as never} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: /Office Mac/ }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "Upload image" }));

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(mocks.imageUploadFailed).toHaveBeenCalledWith(expect.objectContaining({
      message: "图片上传超时，请检查连接后重试",
    }));
    expect(mocks.nativePlugin.cancelImageUpload).toHaveBeenCalledWith({ uploadId: "native-upload-1" });
  });

  it("keeps WebView fetch for the non-native MobileShell preview", async () => {
    mocks.findMobileUpdate.mockResolvedValue({ state: "current" });
    mocks.isNativePlatform.mockReturnValue(false);
    const connection = { id: "mac-1", name: "Office Mac", baseUrl: "https://remote.example.test", lastUsedAt: 1, pairingStatus: "ready" as const };
    const store = {
      list: vi.fn(async () => [connection]),
      credentials: vi.fn(async () => ({ connection, token: "test-token" })),
      select: vi.fn(async () => undefined),
    };
    const settingsStore = {
      read: vi.fn(async () => ({ theme: "system", language: "zh-CN", messageSendMode: "queue" })),
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    render(<MobileShell storeOverride={store as never} settingsStoreOverride={settingsStore as never} />);
    await userEvent.click(await screen.findByRole("button", { name: /Office Mac/ }));

    expect(await screen.findByTestId("image-upload-transport")).toHaveTextContent("web");
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

    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    expect(screen.getByLabelText("不可用")).toBeVisible();
  });

  it("rechecks unavailable connections in the background and marks a recovered connection available", async () => {
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
    const fetchStatus = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: 1, threads: [] }), { status: 200 }));

    render(<MobileShell storeOverride={store as never} settingsStoreOverride={settingsStore as never} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByLabelText("不可用")).toBeVisible();

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });

    expect(fetchStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("可用")).toBeVisible();
  });

  it("probes a saved connection with a stale pairing error when credentials still exist", async () => {
    mocks.findMobileUpdate.mockResolvedValue({ state: "current" });
    const connection = { id: "mac-1", name: "Office Mac", baseUrl: "http://127.0.0.1:4318", lastUsedAt: 1, pairingStatus: "error" as const };
    const store = {
      list: vi.fn(async () => [connection]),
      credentials: vi.fn(async () => ({ connection, token: "test-token" })),
    };
    const settingsStore = {
      read: vi.fn(async () => ({ theme: "system", language: "zh-CN", messageSendMode: "queue" })),
    };
    const fetchStatus = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ version: 1, threads: [] }), { status: 200 }),
    );

    render(<MobileShell storeOverride={store as never} settingsStoreOverride={settingsStore as never} />);

    expect(await screen.findByLabelText("可用")).toBeVisible();
    expect(fetchStatus).toHaveBeenCalledOnce();
    expect(store.credentials).toHaveBeenCalledWith(connection.id);
  });

  it("returns from a native remote conversation list when Android dispatches the system back gesture", async () => {
    mocks.findMobileUpdate.mockResolvedValue({ state: "current" });
    const connection = { id: "mac-1", name: "Office Mac", baseUrl: "http://127.0.0.1:4318", lastUsedAt: 1, pairingStatus: "ready" as const };
    const store = {
      list: vi.fn(async () => [connection]),
      credentials: vi.fn(async () => ({ connection, token: "test-token" })),
      select: vi.fn(async () => undefined),
    };
    const settingsStore = {
      read: vi.fn(async () => ({ theme: "system", language: "zh-CN", messageSendMode: "queue" })),
    };

    render(<MobileShell storeOverride={store as never} settingsStoreOverride={settingsStore as never} />);
    await userEvent.click(await screen.findByRole("button", { name: /Office Mac/ }));
    expect(await screen.findByTestId("active-connection")).toBeVisible();
    await waitFor(() => expect(mocks.capacitorListeners.get("backButton")).toBeTypeOf("function"));

    act(() => mocks.capacitorListeners.get("backButton")?.());

    expect(await screen.findByRole("heading", { name: "选择一台 Mac" })).toBeVisible();
  });

  it("resets stale thread history when switching connections before handling Android back", async () => {
    mocks.findMobileUpdate.mockResolvedValue({ state: "current" });
    const office = { id: "mac-1", name: "Office Mac", baseUrl: "http://127.0.0.1:4318", lastUsedAt: 2, pairingStatus: "ready" as const };
    const home = { id: "mac-2", name: "Home Mac", baseUrl: "http://127.0.0.1:4319", lastUsedAt: 1, pairingStatus: "ready" as const };
    const store = {
      list: vi.fn(async () => [office, home]),
      credentials: vi.fn(async (id: string) => ({ connection: id === office.id ? office : home, token: `${id}-token` })),
      select: vi.fn(async () => undefined),
    };
    const settingsStore = {
      read: vi.fn(async () => ({ theme: "system", language: "zh-CN", messageSendMode: "queue" })),
    };

    render(<MobileShell storeOverride={store as never} settingsStoreOverride={settingsStore as never} />);
    await userEvent.click(await screen.findByRole("button", { name: /Office Mac/ }));
    expect(await screen.findByTestId("active-connection")).toHaveTextContent(office.id);
    window.history.replaceState({ codexRemoteView: "thread", codexRemoteThreadId: "thread-a" }, "");

    await userEvent.click(screen.getByRole("button", { name: "Switch connection" }));
    expect(await screen.findByTestId("active-connection")).toHaveTextContent(home.id);
    expect(window.history.state).toMatchObject({ codexRemoteView: "list" });
    act(() => mocks.capacitorListeners.get("backButton")?.());

    expect(await screen.findByRole("heading", { name: "选择一台 Mac" })).toBeVisible();
  });

  it("rechecks connection status immediately on foreground recovery and removes the listener on unmount", async () => {
    mocks.findMobileUpdate.mockResolvedValue({ state: "current" });
    const connection = { id: "mac-1", name: "Office Mac", baseUrl: "http://127.0.0.1:4318", lastUsedAt: 1, pairingStatus: "ready" as const };
    const store = {
      list: vi.fn(async () => [connection]),
      credentials: vi.fn(async () => ({ connection, token: "test-token" })),
    };
    const settingsStore = {
      read: vi.fn(async () => ({ theme: "system", language: "zh-CN", messageSendMode: "queue" })),
    };
    const fetchStatus = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: 1, threads: [] }), { status: 200 }));

    const view = render(<MobileShell storeOverride={store as never} settingsStoreOverride={settingsStore as never} />);
    expect(await screen.findByLabelText("不可用")).toBeVisible();
    await waitFor(() => expect(mocks.capacitorListeners.get("appStateChange")).toBeTypeOf("function"));

    act(() => mocks.capacitorListeners.get("appStateChange")?.({ isActive: true }));
    expect(await screen.findByLabelText("可用")).toBeVisible();
    expect(fetchStatus).toHaveBeenCalledTimes(2);

    view.unmount();
    await waitFor(() => expect(mocks.capacitorListeners.has("appStateChange")).toBe(false));
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
