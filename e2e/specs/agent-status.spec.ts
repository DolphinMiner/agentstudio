// Agents' health shows where the user looks: the inbox calls out agents that
// need attention, rows say what's wrong, and a diagnostics report (without
// secrets) can be exported from Settings. Desktop only (local connectors).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../support/app";

test.skip(({ platform }) => platform !== "desktop", "connectors run in the Mac app");

test("a signed-out agent is called out in the inbox; diagnostics export without secrets", async ({ app }) => {
  await app.signIn();
  await app.testId("nav-connect").click();
  await app.visible("local-service-grokbot").click();
  await expect(app.visible("local-service-manage-grokbot")).toBeVisible({ timeout: 30_000 });

  // Said once, after the first agent on this Mac connects.
  await expect(app.visible("local-mode-note")).toBeVisible();
  await app.visible("local-mode-note-ok").click();
  await expect(app.testId("local-mode-note")).toHaveCount(0);

  // The account gets signed out on Grok Bot's side.
  await app.openChat("Grok Helper");
  await app.send("please sign me out");

  await app.gotoInbox();
  const trouble = app.visible("agent-trouble");
  await expect(trouble).toContainText("2 agents need attention", { timeout: 30_000 });
  await expect(app.row("Grok Helper").getByTestId("chat-row-status")).toHaveText("Sign in again");
  await app.visible("agent-trouble-fix").click();
  await expect(app.visible("local-service-summary-grokbot")).toContainText("need attention");

  await app.testId("nav-settings").click();
  await app.visible("settings-export-diagnostics").click();
  await expect(app.page.getByText(/Saved to .*agentstudio-diagnostics-/)).toBeVisible();
  const file = readdirSync(app.profile!).find((f) => f.startsWith("agentstudio-diagnostics-"))!;
  const report = readFileSync(join(app.profile!, file), "utf8");
  expect(report).toContain('"status": "needs_login"');
  expect(report).not.toMatch(/fake-(access|refresh)-/);
});
