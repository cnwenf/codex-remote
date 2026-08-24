import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4318",
    browserName: "chromium",
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chrome-desktop", use: { viewport: { width: 1280, height: 800 } } },
    {
      name: "chrome-mobile",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: process.env.CODEX_REMOTE_E2E_EXTERNAL ? undefined : {
    command: "pnpm test:stack",
    url: "http://127.0.0.1:4318/health",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
