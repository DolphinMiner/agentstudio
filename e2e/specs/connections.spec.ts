import { expect, test } from "../support/app";

test("connections are listed as connected and can be removed", async ({ app }) => {
  await app.signIn();
  await app.connect("demo", "demo");
  await app.connect("agentstudio-agents", "concierge");
  await app.gotoInbox();
  await expect(app.row("Concierge")).toBeVisible({ timeout: 30_000 });

  await app.testId("nav-connect").click();
  const rows = app.page.locator('[data-testid="connection-row"]').filter({ visible: true });
  const demo = rows.and(app.page.locator('[data-network="demo"]'));
  const agents = rows.and(app.page.locator('[data-network="agentstudio-agents"]'));
  await expect(demo).toHaveAttribute("data-state", "connected");
  await expect(agents).toHaveAttribute("data-state", "connected");
  await expect(rows).toHaveCount(2);

  await demo.getByTestId("connection-remove").click();
  await expect(demo).toHaveCount(0);
  await expect(agents).toHaveCount(1);
  await expect(agents).toHaveAttribute("data-state", "connected");

  // Removing a connection takes its chats with it.
  await agents.getByTestId("connection-remove").click();
  await expect(agents).toHaveCount(0);
  await app.gotoInbox();
  await expect(app.row("Concierge")).toHaveCount(0, { timeout: 30_000 });
});
