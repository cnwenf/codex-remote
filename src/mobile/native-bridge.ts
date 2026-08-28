import { registerPlugin } from "@capacitor/core";
import type { MobileThreadTarget } from "./deep-link";

export type UpdateDownloadProgress = {
  state: "downloading" | "installing" | "error";
  progress?: number;
  message?: string;
};

export type MonitorConnection = {
  connectionId: string;
  name: string;
  baseUrl: string;
  token: string;
};

export type NativeImageUploadResult = {
  status: number;
  data: unknown;
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
  startImageUpload(): Promise<{ uploadId: string }>;
  appendImageUpload(options: { uploadId: string; data: string }): Promise<void>;
  finishImageUpload(options: {
    uploadId: string;
    url: string;
    token: string;
    fileName: string;
    mimeType: string;
  }): Promise<NativeImageUploadResult>;
  cancelImageUpload(options: { uploadId: string }): Promise<void>;
  downloadAndInstallUpdate(options: {
    url: string;
    checksumUrl: string;
    version: string;
  }): Promise<void>;
  addListener(
    eventName: "openThread",
    listener: (target: MobileThreadTarget) => void,
  ): Promise<{ remove(): Promise<void> }>;
  addListener(
    eventName: "updateDownloadProgress",
    listener: (progress: UpdateDownloadProgress) => void,
  ): Promise<{ remove(): Promise<void> }>;
}

export const CodexRemoteNative = registerPlugin<CodexRemoteNativePlugin>("CodexRemoteNative");
