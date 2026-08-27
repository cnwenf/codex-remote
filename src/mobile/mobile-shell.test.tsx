import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMobileUpdate: vi.fn(),
  nativePlugin: {
    addListener: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
    getLaunchTarget: vi.fn(async () => ({})),
  },
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
    expect(await screen.findByText("v0.5.10")).toBeVisible();
    expect(container.querySelector(".mobile-update-available-dot")).toBeInTheDocument();
  });
});
