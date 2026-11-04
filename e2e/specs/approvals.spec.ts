import { expect, test } from "../support/app";
import type { App } from "../support/app";

async function connectConcierge(app: App): Promise<void> {
  await app.signIn();
  await app.connect("agentstudio-agents", "concierge");
  await app.gotoInbox();
  await app.testId("inbox-filter-agents").filter({ visible: true }).click();
  await expect(app.row("Concierge")).toBeVisible({ timeout: 30_000 });
  await expect(app.row("Concierge").getByTestId("chat-row-network")).toHaveText("Agent");
}

for (const path of [
  { choice: "book", state: "Approved: Book", reply: "Booked. Seat 14A, confirmation PCH412." },
  { choice: "skip", state: "Declined: Don't book", reply: "Okay, I won't book it." },
]) {
  test(`concierge approval: ${path.choice}`, async ({ app, platform }) => {
    await connectConcierge(app);
    await app.row("Concierge").click();
    await expect(app.visible("chat-title")).toHaveText("Concierge");
    await app.send("Find me a flight to Toronto on Friday");

    const card = app.visible("approval-card").last();
    await expect(card.getByTestId("approval-title")).toHaveText("Book the 6pm flight to Toronto for $412?");
    await expect(card.getByTestId("approval-expiry")).toHaveText(/\d+ min left/);
    await expect(app.testId("nav-approvals-badge")).toHaveText("1");

    if (platform === "desktop") {
      // All: the agent waiting on you sits above the list; Agents shows just the list.
      await app.gotoInbox();
      await app.testId("inbox-filter-all").filter({ visible: true }).click();
      await expect(app.visible("agent-waiting").getByTestId("agent-waiting-item")).toHaveText(/Concierge/);
      await app.testId("inbox-filter-agents").filter({ visible: true }).click();
      await expect(app.testId("agent-waiting")).toHaveCount(0);
    }

    await app.testId("nav-approvals").click();
    const list = app.visible("approvals-list");
    await expect(list.getByTestId("approval-card")).toHaveCount(1);
    await expect(list.getByTestId("approval-title")).toHaveText("Book the 6pm flight to Toronto for $412?");
    await list.getByTestId(`approval-choice-${path.choice}`).click();
    await expect(list.getByTestId("approval-state")).toHaveText(path.state);
    await expect(app.testId("nav-approvals-badge")).toHaveCount(0);

    await app.openChat("Concierge");
    await expect(app.message(path.reply, { sender: "Concierge" })).toBeVisible();
    await expect(app.visible("approval-card").last().getByTestId("approval-state")).toHaveText(path.state);
    await app.gotoInbox();
    await expect(app.row("Concierge").getByTestId("chat-row-needs-you")).toHaveCount(0);
  });
}
