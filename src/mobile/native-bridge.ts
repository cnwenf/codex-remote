import { registerPlugin } from "@capacitor/core";
import type { MobileThreadTarget } from "./deep-link";

export type MonitorConnection = {
  connectionId: string;
  name: string;
  baseUrl: string;
  token: string;
};

export interface CodexRemoteNativePlugin {
  readSecret(options: { id: string }): Promise<{ value?: string }>;
  writeSecret(options: { id: string; value: string }): Promise<void>;
  removeSecret(options: { id: string }): Promise<void>;
  startMonitoring(options: MonitorConnection): Promise<void>;
  stopMonitoring(options: { connectionId?: string }): Promise<void>;
  getLaunchTarget(): Promise<MobileThreadTarget | Record<string, never>>;
  scanConnection(): Promise<{ value: string }>;
  openExternalUrl(options: { url: string }): Promise<void>;
  addListener(
    eventName: "openThread",
    listener: (target: MobileThreadTarget) => void,
  ): Promise<{ remove(): Promise<void> }>;
}

export const CodexRemoteNative = registerPlugin<CodexRemoteNativePlugin>("CodexRemoteNative");
