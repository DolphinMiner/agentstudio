import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";
import type { Platform } from "../support/app";

// The README's video and screenshots (docs/media): the desktop app on fake
// data, recorded by readme.media.ts, then put together by render.mjs.
// `pnpm --filter @agentstudio/e2e media` runs both. Needs the local stack running.

// A fake-agents server of its own (with FAKE_AGENTS_MEDIA), not the tests' one.
process.env.FAKE_AGENTS_PORT ??= "18430";
// With the Grok Bot app installed, Grok bots get the avatars Grok Bot draws.
const GROK_APP = "/Applications/Grok Bot.app";
if (process.env.E2E_GROKBOT_APP === undefined && existsSync(GROK_APP)) process.env.E2E_GROKBOT_APP = GROK_APP;

export default defineConfig<{ platform: Platform }>({
  testDir: ".",
  testMatch: "*.media.ts",
  globalSetup: "../global-setup.ts",
  timeout: 600_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  projects: [{ name: "desktop", use: { platform: "desktop" } }],
  webServer: [
    {
      command: "node ../fakes/agents.ts",
      env: { FAKE_AGENTS_PORT: process.env.FAKE_AGENTS_PORT, FAKE_AGENTS_MEDIA: "1", NODE_NO_WARNINGS: "1" },
      url: `http://127.0.0.1:${process.env.FAKE_AGENTS_PORT}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
