// C: agents reached through the user's own signed-in session, running in the
// desktop app (Grok Bot, Muse, ChatGPT Dots). Desktop only. The app talks to
// e2e/fakes/agents.ts instead of the real services; the fakes mirror what the
// connectors expect from the live ones (see apps/desktop/src/main/connectors).

import { expect, test } from "../support/app";
import type { App } from "../support/app";

test.skip(({ platform }) => platform !== "desktop", "connectors run in the Mac app");

async function startConnect(app: App, service: string) {
  await app.testId("nav-connect").click();
  await app.visible(`local-service-${service}`).click();
  await expect(app.visible("local-login-status")).toBeVisible();
}

/**
 * Waits until the connect flow finishes, then checks the service's agents in
 * its sheet (one card per service on the Connect screen) and closes it.
 */
async function connected(app: App, service: string, count = 1) {
  await expect(app.testId("local-login")).toHaveCount(0, { timeout: 30_000 });
  await expect(app.testId("local-login-error")).toHaveCount(0);
  await app.visible(`local-service-manage-${service}`).click();
  const rows = app.page.locator(`[data-testid="local-connector-row"][data-service="${service}"]`);
  await expect(rows).toHaveCount(count, { timeout: 30_000 });
  for (const row of await rows.all()) await expect(row).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
  await app.visible("local-sheet-close").click();
  await expect(app.testId("local-sheet")).toHaveCount(0);
}

/** Runs in the page: the average color of an image's opaque pixels, and whether it reads as violet. */
function averageColor(img: HTMLImageElement) {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d")!;
  g.drawImage(img, 0, 0, 32, 32);
  const d = g.getImageData(0, 0, 32, 32).data;
  let [r, gr, b, n] = [0, 0, 0, 0];
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3]! < 200) continue;
    r += d[i]!;
    gr += d[i + 1]!;
    b += d[i + 2]!;
    n++;
  }
  [r, gr, b] = [r / n, gr / n, b / n];
  return { r, g: gr, b, violet: n > 0 && b > r && r > gr + 20 };
}

async function openAgent(app: App, name: string) {
  await app.gotoInbox();
  await app.testId("inbox-filter-agents").filter({ visible: true }).click();
  await expect(app.row(name)).toBeVisible({ timeout: 30_000 });
  await app.row(name).click();
  await expect(app.visible("chat-title")).toHaveText(name);
}

/** Signs in on a fake web service: its sign-in window (the only one on that URL so far) shows a "Log in" button. */
async function signInWindow(app: App, url: RegExp) {
  const win = await app.window(url);
  await win.locator("#login").click();
}

test("Grok Bot: one sign-in connects every bot; chat and answer a card", async ({ app }) => {
  await app.signIn();
  await startConnect(app, "grokbot");
  // The sign-in page opens (here in a window; normally the browser). The account has two bots: both connect.
  await connected(app, "grokbot", 2);
  // One card per service: the bots sit behind it, in its sheet.
  await expect(app.visible("local-service-summary-grokbot")).toContainText("2 agents");
  // Agents on this Mac are listed once, with their service, not again under "Connected".
  await expect(app.page.locator('[data-testid="connection-row"]').filter({ visible: true })).toHaveCount(0);
  await app.gotoInbox();
  await app.testId("inbox-filter-agents").filter({ visible: true }).click();
  await expect(app.row("Sales Bot")).toBeVisible({ timeout: 30_000 });
  // Sales Bot has no photo: with the Grok Bot app installed, its avatar is the one Grok Bot
  // draws (a violet cloud); without it, the Grok Bot icon. Never initials.
  const salesAvatar = app.row("Sales Bot").getByTestId("avatar-image");
  await expect(salesAvatar).toBeVisible({ timeout: 30_000 });
  const drawn = !!process.env.E2E_GROKBOT_APP;
  await expect.poll(() => salesAvatar.evaluate(averageColor), { timeout: 15_000 }).toMatchObject({ violet: drawn });

  // Its earlier conversation came over as history, both sides.
  await openAgent(app, "Sales Bot");
  await expect(app.message("Revenue was up 12%.", { sender: "Sales Bot" })).toBeVisible({ timeout: 15_000 });
  const asked = app.message("How did last quarter go?", { own: true });
  await expect(asked).toBeVisible();
  await expect(asked.getByTestId("message-via")).toHaveText("In Grok Bot");

  await openAgent(app, "Grok Helper");
  // The bot's own avatar, fetched from Grok Bot, shows up as the agent's picture.
  await expect(app.visible("chat-identity").getByTestId("avatar-image")).toBeVisible({ timeout: 30_000 });
  await app.send("hello grok");
  await expect(app.message("Grok echo: hello grok", { sender: "Grok Helper" })).toBeVisible();
  // AgentStudio's own message is in Grok Bot's transcript too; it isn't shown twice.
  await expect(app.message("hello grok", { own: true })).toHaveCount(1);

  // Something AgentStudio can't show yet is announced, not dropped.
  await app.send("send a chart");
  await expect(app.messages({ sender: "Grok Helper" }).filter({ hasText: "Grok Bot sent a chart" })).toBeVisible({ timeout: 15_000 });
  // What the user writes in Grok Bot's own app shows as theirs.
  await app.send("I'm on my phone");
  const fromApp = app.message("Sent from the Grok Bot app", { own: true });
  await expect(fromApp).toBeVisible({ timeout: 15_000 });
  await expect(fromApp.getByTestId("message-via")).toHaveText("In Grok Bot");

  await app.send("prepare the report");
  await expect(app.message("The weekly report is ready.", { sender: "Grok Helper" })).toBeVisible();
  const card = app.visible("approval-card").last();
  await expect(card.getByTestId("approval-title")).toHaveText("Send the weekly report to the team?");
  await expect(card.getByTestId("approval-choice-hold")).toHaveText("Don't send");
  await card.getByTestId("approval-choice-send").click();
  await expect(card.getByTestId("approval-state")).toHaveText("Approved: Send it");
  await expect(app.message("Sent the report to the team.", { sender: "Grok Helper" })).toBeVisible();

  // A chat can be deleted from its menu.
  await openAgent(app, "Sales Bot");
  await app.visible("chat-menu").click();
  await app.visible("chat-delete").click();
  await app.visible("chat-delete-confirm").click();
  await expect(app.row("Sales Bot")).toHaveCount(0, { timeout: 15_000 });
});

test("Cue: sign in with the Manus account; AgentStudio makes its own API key", async ({ app }) => {
  await app.signIn();
  await startConnect(app, "cue");
  // Manus sign-in opens in the browser (a window in tests); its cuedev:// link comes back to AgentStudio.
  await signInWindow(app, /\/cue-web\/login/);
  await connected(app, "cue", 2);
  await openAgent(app, "Cue");
  await app.send("hi from the web sign-in");
  await expect(app.message("Cue echo: hi from the web sign-in", { sender: "Cue" })).toBeVisible({ timeout: 15_000 });
});

test("Cue: connect with a Manus API key; chat, answer a question and confirm an action", async ({ app }) => {
  await app.signIn();
  await startConnect(app, "cue");
  await app.visible("local-login-action-api-key").click();
  // A wrong key is refused, and the step asks again.
  await app.visible("local-login-input").fill("not-a-key");
  await app.visible("local-login-submit").click();
  await expect(app.visible("local-login-input-error")).toBeVisible({ timeout: 15_000 });
  await app.visible("local-login-input").fill(`cue-key-${Date.now()}`);
  await app.visible("local-login-submit").click();
  // The account's default agent and its custom agent both connect.
  await connected(app, "cue", 2);

  await openAgent(app, "Trip Planner");
  // The earlier conversation came over as history.
  await expect(app.message("Here's a two-day Kyoto plan.", { sender: "Trip Planner" })).toBeVisible({ timeout: 15_000 });
  await expect(app.message("Plan a weekend in Kyoto", { own: true }).getByTestId("message-via")).toHaveText("In Cue");
  await app.send("hello cue");
  await expect(app.message("Cue echo: hello cue", { sender: "Trip Planner" })).toBeVisible({ timeout: 15_000 });
  await expect(app.message("hello cue", { own: true })).toHaveCount(1);

  // Files come over: an image shows in the chat.
  await app.send("send me a photo");
  await expect(app.messages({ sender: "Trip Planner" }).getByTestId("message-image")).toBeVisible({ timeout: 20_000 });
  // What the user writes in the Cue app shows as theirs.
  await app.send("I'm on my phone");
  await expect(app.message("Sent from the Cue app", { own: true }).getByTestId("message-via")).toHaveText("In Cue", { timeout: 15_000 });

  // A question with options becomes a card; the answer goes back as a message.
  await app.send("take a screenshot");
  const question = app.visible("approval-card").last();
  await expect(question.getByTestId("approval-title")).toHaveText("Which computer?", { timeout: 15_000 });
  await question.getByTestId("approval-choice-o1").click();
  await expect(app.message("Took a screenshot of the MacBook Air.", { sender: "Trip Planner" })).toBeVisible({ timeout: 15_000 });

  // An action confirmation becomes an approval.
  await app.send("send the email");
  const confirm = app.visible("approval-card").last();
  await expect(confirm.getByTestId("approval-title")).toHaveText("Send email to sam@example.com", { timeout: 15_000 });
  await confirm.getByTestId("approval-choice-accept").click();
  await expect(app.message("Sent the email to Sam.", { sender: "Trip Planner" })).toBeVisible({ timeout: 15_000 });
});

test("Muse: sign in in an AgentStudio window, chat and approve on the page", async ({ app }) => {
  await app.signIn();
  await startConnect(app, "muse");
  await signInWindow(app, /\/muse\//);
  await connected(app, "muse");
  // The service opens in the browser ("View in Muse"); AgentStudio's own page window never shows.
  await app.visible("local-service-manage-muse").click();
  await expect(app.visible("local-connector-open")).toHaveText("View in Muse");
  await app.visible("local-sheet-close").click();

  await openAgent(app, "Muse");
  // The persona's picture from the Muse page becomes the agent's avatar.
  await expect(app.visible("chat-identity").getByTestId("avatar-image")).toBeVisible({ timeout: 30_000 });
  await app.send("hi muse");
  await expect(app.message("Muse echo: hi muse", { sender: "Muse" })).toBeVisible();
  // The page's earlier conversation comes over once, as history; message menus are not decisions.
  await expect(app.message("Old answer from yesterday.")).toHaveCount(1);
  await expect(app.visible("approval-card")).toHaveCount(0);

  // Paragraphs and lists keep their line breaks.
  await app.send("how is the weather");
  await expect(app.message("Today: rain, 25°C.\n\n• Tue: showers\n• Wed: cold front\n\nTake an umbrella.", { sender: "Muse" })).toBeVisible();

  await app.send("book dinner for two");
  await expect(app.message("I found a table for 2 at 7:30 at Nopa.", { sender: "Muse" })).toBeVisible();
  const card = app.visible("approval-card").last();
  await expect(card.getByTestId("approval-title")).toHaveText("I found a table for 2 at 7:30 at Nopa.");
  await card.getByTestId("approval-choice-b0").click(); // "Approve", clicked on the Muse page
  await expect(card.getByTestId("approval-state")).toHaveText("Approved: Approve");
  await expect(app.message("Booked! See you at 7:30.", { sender: "Muse" })).toBeVisible();

  // When the Muse page loses its connection, AgentStudio says so and reloads it, without showing a window.
  const windows = app.electron!.windows().length;
  await app.send("drop the connection");
  await app.gotoInbox();
  const status = app.row("Muse").getByTestId("chat-row-status");
  await expect(status).toHaveText("Reconnecting…", { timeout: 30_000 });
  // The first reload doesn't help (the fake keeps failing once); the next one, after a backoff, does.
  await expect(status).toHaveCount(0, { timeout: 60_000 });
  expect(app.electron!.windows().length).toBe(windows);
  await openAgent(app, "Muse");
  await app.send("are you back");
  await expect(app.message("Muse echo: are you back", { sender: "Muse" })).toBeVisible({ timeout: 30_000 });
});

test("ChatGPT Dots: chat, approve on the page, and draft replies for another chat", async ({ app }) => {
  await app.signIn();
  await app.connect("demo", "demo");
  await startConnect(app, "dots");
  await signInWindow(app, /\/dots\//);
  await connected(app, "dots");

  await openAgent(app, "Dots");
  await app.send("hi dots");
  await expect(app.message("Dots echo: hi dots", { sender: "Dots" })).toBeVisible();

  await app.send("please approve my expense report");
  const card = app.visible("approval-card").last();
  await expect(card.getByTestId("approval-title")).toHaveText("The expense report is ready to submit.");
  await card.getByTestId("approval-choice-b1").click(); // "Deny"
  await expect(card.getByTestId("approval-state")).toHaveText("Declined: Deny");
  await expect(app.message("Okay, not submitting it.", { sender: "Dots" })).toBeVisible();

  // Ask Dots about a message in another chat; the drafts come back as a card.
  await app.gotoInbox();
  await app.testId("inbox-filter-all").filter({ visible: true }).click();
  await app.openChat("Leo Park");
  await app.askAbout(app.message("Are we still on for 7:15?", { sender: "Leo Park" }));
  await app.visible("ask-agent-Dots").click();
  await app.visible("ask-send").click();
  await expect(app.visible("chat-title")).toHaveText("Dots");
  const drafts = app.visible("drafts-card").last();
  await expect(drafts.getByTestId("draft-item")).toHaveCount(3, { timeout: 30_000 });
  await expect(drafts.getByTestId("draft-item").first()).toContainText("Absolutely, count me in.");
});
