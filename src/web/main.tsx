import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { watchAppVersion } from "./api/app-version";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing root element");
}

watchAppVersion();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
