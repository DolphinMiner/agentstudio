import { defineConfig, devices } from "@playwright/test";

// Smoke test for the mobile app's static web export, in Chromium with iPhone 15
// emulation. Needs the local stack (`pnpm dev:up`) and a build
// (`pnpm build:web`; `pnpm e2e:smoke` does both build and test).
const PORT = Number(process.env.MOBILE_WEB_PORT ?? 18300);

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [["list"]],
  outputDir: "./artifacts/test-results",
  use: {
    ...devices["iPhone 15"],
    browserName: "chromium",
    baseURL: `http://127.0.0.1:${PORT}`,
  },
  webServer: {
    command: "node scripts/serve-web.mjs",
    cwd: "..",
    env: { PORT: String(PORT) },
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
