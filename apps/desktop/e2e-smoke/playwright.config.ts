import { defineConfig } from "@playwright/test";

// Smoke tests for the BUILT desktop app (run `pnpm build` first, or use
// `pnpm e2e:smoke`, which builds). Needs the local stack: `pnpm dev:up`.
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [["list"]],
  outputDir: "./artifacts/test-results",
});
