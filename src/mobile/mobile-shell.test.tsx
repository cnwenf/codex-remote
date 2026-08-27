import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

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
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
