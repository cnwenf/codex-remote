import { Preferences } from "@capacitor/preferences";

export type MobileTheme = "system" | "light" | "dark";
export type MobileLanguage = "zh-CN" | "en";
export type MobileMessageSendMode = "queue" | "steer";

export type MobileSettings = {
  theme: MobileTheme;
  language: MobileLanguage;
  messageSendMode: MobileMessageSendMode;
};

export const DEFAULT_MOBILE_SETTINGS: MobileSettings = {
  theme: "system",
  language: "zh-CN",
  messageSendMode: "queue",
};

export interface MobileSettingsPersistence {
  read(): Promise<unknown>;
  write(settings: MobileSettings): Promise<void>;
}

export class MobileSettingsStore {
  constructor(private readonly persistence: MobileSettingsPersistence) {}

  async read(): Promise<MobileSettings> {
    return normalizeMobileSettings(await this.persistence.read());
  }

  async write(settings: MobileSettings) {
    const normalized = normalizeMobileSettings(settings);
    await this.persistence.write(normalized);
    return normalized;
  }
}

const SETTINGS_KEY = "codex-remote.mobile-settings.v1";

export class CapacitorMobileSettingsPersistence implements MobileSettingsPersistence {
  async read() {
    const { value } = await Preferences.get({ key: SETTINGS_KEY });
    if (!value) return undefined;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }

  async write(settings: MobileSettings) {
    await Preferences.set({ key: SETTINGS_KEY, value: JSON.stringify(settings) });
  }
}

export class InMemoryMobileSettingsPersistence implements MobileSettingsPersistence {
  constructor(private value?: unknown) {}
  async read() { return structuredClone(this.value); }
  async write(settings: MobileSettings) { this.value = structuredClone(settings); }
}

export function applyMobileSettings(settings: MobileSettings, root = document.documentElement) {
  if (settings.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = settings.theme;
  root.lang = settings.language;
}

function normalizeMobileSettings(value: unknown): MobileSettings {
  if (!value || typeof value !== "object") return { ...DEFAULT_MOBILE_SETTINGS };
  const record = value as Record<string, unknown>;
  return {
    theme: isTheme(record.theme) ? record.theme : DEFAULT_MOBILE_SETTINGS.theme,
    language: isLanguage(record.language) ? record.language : DEFAULT_MOBILE_SETTINGS.language,
    messageSendMode: isMessageSendMode(record.messageSendMode)
      ? record.messageSendMode
      : DEFAULT_MOBILE_SETTINGS.messageSendMode,
  };
}

function isTheme(value: unknown): value is MobileTheme {
  return value === "system" || value === "light" || value === "dark";
}

function isLanguage(value: unknown): value is MobileLanguage {
  return value === "zh-CN" || value === "en";
}

function isMessageSendMode(value: unknown): value is MobileMessageSendMode {
  // Older builds could persist `steer`, which interrupts the active Desktop
  // turn. Normalize every persisted/write value to queue during migration.
  return value === "queue";
}
