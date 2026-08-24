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
    {Capacitor.isNativePlatform() ? <MobileShell /> : <App />}
  </StrictMode>,
);
