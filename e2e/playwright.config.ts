import { defineConfig, devices } from "@playwright/test";

// `npx playwright test` runs Chromium; add --project=firefox, --project=webkit (Safari's engine) or
// --project=phone (an iPhone-sized touch device) for the others, or --project=all-browsers.
const auth = process.env.E2E_PASSWORD ? { storageState: ".auth/state.json" } : {};

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./global-setup.ts",
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3100",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 800 },
    ...auth,
  },
  outputDir: "./test-results",
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, ...auth } },
    { name: "firefox", use: { ...devices["Desktop Firefox"], viewport: { width: 1280, height: 800 }, ...auth } },
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 800 }, ...auth } },
    { name: "phone", use: { ...devices["iPhone 14"], ...auth } },
  ],
});
