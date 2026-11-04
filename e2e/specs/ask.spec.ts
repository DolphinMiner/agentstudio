import { expect, test } from "../support/app";

const ANCHOR = "Are we still on for 7:15?";
const FIRST_DRAFT = "Leo, sounds good, see you then!";

test("ask an agent: preview, drafts, use a draft, task done, then skip the preview", async ({ app }) => {
  await app.signIn();
  await app.connect("demo", "demo");
  await app.connect("agentstudio-agents", "concierge");
  await app.gotoInbox();
  await expect(app.row("Concierge")).toBeVisible({ timeout: 30_000 });

  await app.openChat("Leo Park");
  await app.askAbout(app.message(ANCHOR, { sender: "Leo Park" }));
  await app.visible("ask-agent-Concierge").click();
  await expect(app.visible("ask-request")).toHaveValue("Draft a reply");
  const lines = app.visible("ask-line");
  await expect(lines).toHaveCount(2);
  await expect(lines.first()).toContainText("Hey! Long time");
  await expect(lines.last()).toContainText(ANCHOR);
  await expect(app.visible("ask-dont-ask")).toBeVisible();
  await app.visible("ask-send").click();

  // The app opens the agent's chat, where the drafts arrive.
  await expect(app.visible("chat-title")).toHaveText("Concierge");
  const drafts = app.visible("drafts-card").last();
  await expect(drafts.getByTestId("draft-item")).toHaveCount(3, { timeout: 30_000 });
  await expect(drafts.getByTestId("draft-item").first()).toContainText(FIRST_DRAFT);
  await drafts.getByTestId("draft-use").first().click();

  await expect(app.visible("chat-title")).toHaveText("Leo Park");
  await expect(app.visible("composer-input")).toHaveValue(FIRST_DRAFT);
  await app.visible("composer-send").click();
  await expect(app.message(`Echo: ${FIRST_DRAFT}`, { sender: "Leo Park" })).toBeVisible();

  await app.testId("nav-tasks").click();
  await expect(app.visible("tasks-board")).toBeVisible();
  await expect(app.visible("tasks-col-done").locator('[data-testid="task-card"][data-state="done"]')).toHaveCount(1);

  // Second ask: tick "Don't ask again".
  await app.openChat("Leo Park");
  await app.askAbout(app.message(ANCHOR, { sender: "Leo Park" }));
  await expect(app.visible("ask-line")).toHaveCount(2);
  await app.visible("ask-dont-ask").click();
  await app.visible("ask-send").click();
  await expect(app.visible("chat-title")).toHaveText("Concierge");
  await expect(app.visible("drafts-card")).toHaveCount(2, { timeout: 30_000 });

  // Third ask: the preview is skipped for this agent.
  await app.openChat("Leo Park");
  await app.askAbout(app.message(ANCHOR, { sender: "Leo Park" }));
  await expect(app.visible("ask-agent-Concierge")).toBeVisible();
  await expect(app.testId("ask-line")).toHaveCount(0);
  await expect(app.testId("ask-dont-ask")).toHaveCount(0);
  await app.visible("ask-send").click();
  await expect(app.visible("chat-title")).toHaveText("Concierge");
  await expect(app.visible("drafts-card")).toHaveCount(3, { timeout: 30_000 });
});
