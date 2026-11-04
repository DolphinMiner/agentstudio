// A: agents over open protocols, through agentstudio-agent-adapters. The dev
// stack runs a tiny A2A agent (agentstudio-dev-a2a-echo) and allows one ACP agent
// (agentstudio-dev-acp-echo). Same scenarios on desktop and mobile web.

import { expect, test } from "../support/app";
import type { App } from "../support/app";

const A2A_URL = "http://127.0.0.1:18203";

async function openAgent(app: App, name: string) {
  await app.gotoInbox();
  await app.testId("inbox-filter-agents").filter({ visible: true }).click();
  await expect(app.row(name)).toBeVisible({ timeout: 30_000 });
  await expect(app.row(name).getByTestId("chat-row-network")).toHaveText("Agent");
  await app.row(name).click();
  await expect(app.visible("chat-title")).toHaveText(name);
}

test("A2A agent: chat, a long-running task, and an approval card", async ({ app, platform }) => {
  await app.signIn();
  await app.connectWith("agentstudio-agents", "a2a", { url: A2A_URL });
  await openAgent(app, "A2A Echo");
  // An agent without a picture of its own shows an icon, never initials (desktop).
  if (platform === "desktop") await expect(app.visible("chat-identity").getByTestId("avatar-initials")).toHaveCount(0);

  await app.send("hello there");
  await expect(app.message("A2A echo: hello there", { sender: "A2A Echo" })).toBeVisible();

  await app.send("slow report");
  await expect(app.message("Done: slow report", { sender: "A2A Echo" })).toBeVisible();

  await app.send("book a table");
  const card = app.visible("approval-card").last();
  await expect(card.getByTestId("approval-title")).toHaveText("Book the table at Nopa for 7:30?");
  await expect(card.getByTestId("approval-detail")).toContainText("2 people");
  await card.getByTestId("approval-choice-book").click();
  await expect(card.getByTestId("approval-state")).toHaveText("Approved: Book");
  await expect(app.message("Table booked.", { sender: "A2A Echo" })).toBeVisible();
});

test("ACP agent: chat and a permission request", async ({ app }) => {
  await app.signIn();
  await app.connectWith("agentstudio-agents", "acp", {});
  await openAgent(app, "ACP Echo");

  await app.send("hi acp");
  await expect(app.message("ACP echo: hi acp", { sender: "ACP Echo" })).toBeVisible();

  await app.send("please delete notes");
  const card = app.visible("approval-card").last();
  await expect(card.getByTestId("approval-title")).toHaveText("Delete notes.txt");
  await card.getByTestId("approval-choice-reject").click();
  await expect(card.getByTestId("approval-state")).toHaveText("Declined: Reject");
  await expect(app.message("Okay, I left it alone.", { sender: "ACP Echo" })).toBeVisible();
});
