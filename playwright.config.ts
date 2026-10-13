import { defineConfig, devices } from "@playwright/test";

const ci = !!process.env.CI;
const chromium = { name: "chromium", use: { ...devices["Desktop Chrome"] } };

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: ci,
  retries: 0,
  workers: ci ? 2 : undefined,
  use: {
    baseURL: "http://127.0.0.1:5174",
    headless: true,
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 5174",
    url: "http://127.0.0.1:5174",
    reuseExistingServer: false,
    timeout: 120_000,
  },
  // CI runs headless Chromium only. Firefox and WebKit stay available locally.
  projects: ci
    ? [chromium]
    : [
        chromium,
        { name: "firefox", use: { ...devices["Desktop Firefox"] } },
        { name: "webkit", use: { ...devices["Desktop Safari"] } },
      ],
});
