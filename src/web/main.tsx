import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import { MobileShell } from "../mobile/mobile-shell";
import { App } from "./app";
import { watchAppVersion } from "./api/app-version";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing root element");
}

watchAppVersion();

createRoot(root).render(
  <StrictMode>
    {Capacitor.isNativePlatform() || isLocalMobilePreview() ? <MobileShell /> : <App />}
  </StrictMode>,
);

function isLocalMobilePreview() {
  if (typeof window === "undefined") return false;
  const loopback = window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";
  return loopback && new URLSearchParams(window.location.search).get("mobile-shell-preview") === "1";
}
