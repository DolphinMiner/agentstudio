// Makes sure the local stack is up and healthy and the apps under test are
// built. Set E2E_SKIP_BUILD=1 to reuse existing builds, E2E_SKIP_STACK=1 to
// skip `dev:up` (the stack must then already be running).

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FullConfig } from "@playwright/test";
import { DESKTOP_APP_DIR } from "./support/app";
import { REPO_ROOT, health, healthy } from "./support/stack";

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const res = spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: "inherit", env });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${res.status})`);
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  if (!process.env.E2E_SKIP_STACK) run("node", ["dev/stack.mjs", "up"]);

  // Bridges report healthy to the stack manager before the API sees them; wait for the API's view.
  const deadline = Date.now() + 60_000;
  let h = await health();
  while (!healthy(h) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    h = await health();
  }
  if (!healthy(h)) throw new Error(`API health is not OK: ${JSON.stringify(h)}`);

  const projects = new Set(config.projects.map((p) => p.name));
  if (!process.env.E2E_SKIP_BUILD) {
    if (projects.has("desktop")) run("pnpm", ["--filter", "@agentstudio/desktop", "build"]);
    // The web server (started by Playwright before this setup) serves files from disk, so rebuilding here is enough.
    if (projects.has("mobile-web")) run("pnpm", ["--filter", "@agentstudio/mobile", "build:web"]);
  }
  if (projects.has("desktop") && !existsSync(join(DESKTOP_APP_DIR, "node_modules", "electron", "path.txt"))) {
    throw new Error("Electron binary missing: run `node node_modules/electron/install.js` in apps/desktop");
  }
}
