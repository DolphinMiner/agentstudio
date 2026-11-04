import { defineConfig, devices } from "@playwright/test";
import type { Platform } from "./support/app";

// E2e for both clients against the local stack (see docs/clients.md for the
// test ids). `pnpm test:e2e` from the repo root starts the stack if needed.
const MOBILE_PORT = Number(process.env.MOBILE_WEB_PORT ?? 18300);
// Separate ports let two checkouts (worktrees) run e2e at the same time.
const FAKE_AGENTS_PORT = Number(process.env.FAKE_AGENTS_PORT ?? 18410);

export default defineConfig<{ platform: Platform }>({
  testDir: "./specs",
  globalSetup: "./global-setup.ts",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: true,
  // Each test gets its own user; a few clients at a time keep the stack responsive.
  workers: Number(process.env.E2E_WORKERS ?? 3),
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [["list"], ["html", { open: "never" }]],
  projects: [
    { name: "desktop", use: { platform: "desktop" } },
    {
      name: "mobile-web",
      use: {
        platform: "mobile",
        ...devices["iPhone 15"],
        browserName: "chromium",
        baseURL: `http://127.0.0.1:${MOBILE_PORT}`,
      },
    },
  ],
  webServer: [
    {
      // Serves apps/mobile/web-build (built by the global setup) from disk.
      command: "node ../apps/mobile/scripts/serve-web.mjs",
      env: { PORT: String(MOBILE_PORT) },
      port: MOBILE_PORT,
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      // Fake Grok Bot backend and Muse / Dots pages for the desktop connectors.
      command: "node fakes/agents.ts",
      env: { FAKE_AGENTS_PORT: String(FAKE_AGENTS_PORT), NODE_NO_WARNINGS: "1" },
      url: `http://127.0.0.1:${FAKE_AGENTS_PORT}/health`,
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
