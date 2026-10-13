import { defineConfig } from "@playwright/test";

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
    ...(process.env.E2E_PASSWORD ? { storageState: ".auth/state.json" } : {}),
  },
  outputDir: "./test-results",
});
