import { describe, expect, it } from "vitest";
import {
  applyMobileSettings,
  DEFAULT_MOBILE_SETTINGS,
  InMemoryMobileSettingsPersistence,
  MobileSettingsStore,
} from "./settings-store";

describe("MobileSettingsStore", () => {
  it("starts with safe defaults that preserve the current mobile behavior", async () => {
    const store = new MobileSettingsStore(new InMemoryMobileSettingsPersistence());

    await expect(store.read()).resolves.toEqual({
      theme: "system",
      language: "zh-CN",
      messageSendMode: "queue",
    });
  });

  it("persists theme language and message send mode across store instances", async () => {
    const persistence = new InMemoryMobileSettingsPersistence();
    const first = new MobileSettingsStore(persistence);
    await first.write({ theme: "dark", language: "en", messageSendMode: "steer" });

    const second = new MobileSettingsStore(persistence);
    await expect(second.read()).resolves.toEqual({
      theme: "dark",
      language: "en",
      messageSendMode: "queue",
    });
    expect(DEFAULT_MOBILE_SETTINGS.messageSendMode).toBe("queue");
  });

  it("migrates a previously saved steer mode to queue so a new message cannot interrupt the active turn", async () => {
    const store = new MobileSettingsStore(new InMemoryMobileSettingsPersistence({
      theme: "system",
      language: "zh-CN",
      messageSendMode: "steer",
    }));

    await expect(store.read()).resolves.toEqual({
      theme: "system",
      language: "zh-CN",
      messageSendMode: "queue",
    });
  });

  it("repairs unknown persisted values instead of applying invalid UI state", async () => {
    const persistence = new InMemoryMobileSettingsPersistence({
      theme: "neon",
      language: "fr",
      messageSendMode: "replace",
    });
    const store = new MobileSettingsStore(persistence);

    await expect(store.read()).resolves.toEqual(DEFAULT_MOBILE_SETTINGS);
  });

  it("applies and clears explicit theme overrides while updating the document language", () => {
    const root = document.createElement("html");
    applyMobileSettings({ theme: "dark", language: "en", messageSendMode: "queue" }, root);
    expect(root.dataset.theme).toBe("dark");
    expect(root.lang).toBe("en");

    applyMobileSettings(DEFAULT_MOBILE_SETTINGS, root);
    expect(root.dataset.theme).toBeUndefined();
    expect(root.lang).toBe("zh-CN");
  });
});
