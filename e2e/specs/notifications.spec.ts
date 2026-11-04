import { expect, test } from "../support/app";
import type { App } from "../support/app";
import { SERVER_URL, demoIncoming } from "../support/stack";

// System notifications and the Dock badge (docs/clients.md § Notifications).
// The app runs with AGENTSTUDIO_TEST_NOTIFICATIONS=1, so the main process records
// what it would show instead of showing it.

test.skip(({ platform }) => platform !== "desktop", "notifications and the Dock badge are desktop only");

const FLIGHT_TITLE = "Book the 6pm flight to Toronto for $412?";

async function connectConcierge(app: App): Promise<string> {
  await app.signIn();
  await app.connect("agentstudio-agents", "concierge");
  await app.gotoInbox();
  await expect(app.row("Concierge")).toBeVisible({ timeout: 30_000 });
  const s = await app.session();
  const res = await fetch(`${SERVER_URL}/v1/agents`, { headers: { Authorization: `Bearer ${s.access_token}` } });
  const { agents } = (await res.json()) as { agents: { name: string; room_id: string | null }[] };
  const roomId = agents.find((a) => a.name === "Concierge")?.room_id;
  if (!roomId) throw new Error("Concierge has no room");
  return roomId;
}

/** Sends a message as the user from another device, so the app sees the agent's answer arrive while it looks elsewhere. */
async function sendFromElsewhere(app: App, roomId: string, text: string): Promise<void> {
  const { matrix } = await app.session();
  const txn = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const url = `${matrix.homeserver_url}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${matrix.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ msgtype: "m.text", body: text }),
  });
  if (!res.ok) throw new Error(`send: HTTP ${res.status} ${await res.text()}`);
}

const approvalsShown = async (app: App) => (await app.notifications()).filter((n) => n.kind === "approval");

test("a Concierge approval notifies, sets the Dock badge, opens on click, and stops when muted", async ({ app }) => {
  const roomId = await connectConcierge(app);
  await app.testId("nav-tasks").click();
  await sendFromElsewhere(app, roomId, "Find me a flight to Toronto on Friday");

  // The approval is announced with its title and the agent's name; the reply before it with its first words.
  await expect.poll(() => approvalsShown(app)).toEqual([
    { kind: "approval", priority: "high", title: FLIGHT_TITLE, body: "Concierge", open: { view: "approvals" }, roomId },
  ]);
  const shown = await app.notifications();
  expect(shown).toContainEqual(expect.objectContaining({ kind: "agent_message", title: "Concierge", open: { view: "inbox", roomId } }));
  // History that arrives with a chat (backfill, imports) is never announced, and nothing comes twice.
  expect(new Set(shown.map((n) => `${n.kind}:${n.body}`)).size).toBe(shown.length);

  // The badge is the pending approvals plus the unread agent messages, as the inbox shows them.
  await expect(app.testId("nav-approvals-badge")).toHaveText("1");
  await app.gotoInbox();
  const unread = Number(await app.row("Concierge").getByTestId("chat-row-unread").textContent());
  expect(unread).toBeGreaterThan(0);
  await expect.poll(() => app.badge()).toBe(1 + unread);

  // Clicking the approval opens Approvals; clicking the reply opens the chat.
  await app.testId("nav-tasks").click();
  await app.clickNotification(shown.findIndex((n) => n.kind === "approval"));
  await expect(app.visible("approvals-list").getByTestId("approval-title")).toHaveText(FLIGHT_TITLE);
  await app.clickNotification(shown.findIndex((n) => n.kind === "agent_message"));
  await expect(app.visible("chat-title")).toHaveText("Concierge");

  // Mute Concierge from the chat menu: its next approval and reply are not announced.
  await app.testId("chat-menu").click();
  await app.testId("chat-notify-mute").click();
  await app.testId("chat-menu").click();
  await expect(app.testId("chat-notify-mute")).toHaveAttribute("aria-checked", "true");
  await app.testId("chat-menu").click();
  const before = (await app.notifications()).length;
  await app.testId("nav-tasks").click();
  await sendFromElsewhere(app, roomId, "Find me a flight to Toronto on Saturday");
  await expect(app.testId("nav-approvals-badge")).toHaveText("2");

  // Back to all notifications (from Settings): the next approval is announced again.
  await app.testId("nav-settings").click();
  const mode = app.page.locator('[data-testid="settings-agent-notify"][data-agent-name="Concierge"]');
  await expect(mode).toHaveValue("mute");
  await mode.selectOption("all");
  await expect(mode).toHaveValue("all");
  await app.testId("nav-tasks").click();
  await sendFromElsewhere(app, roomId, "Find me a flight to Toronto on Sunday");
  await expect(app.testId("nav-approvals-badge")).toHaveText("3");
  await expect.poll(async () => (await approvalsShown(app)).length).toBe(2);
  const later = (await app.notifications()).slice(before);
  expect(later.map((n) => n.kind)).toEqual(["agent_message", "approval"]);
});

test("the notification switch and per-agent modes survive a restart", async ({ app }) => {
  await connectConcierge(app);
  await app.testId("nav-settings").click();
  const mode = app.page.locator('[data-testid="settings-agent-notify"][data-agent-name="Concierge"]');
  await mode.selectOption("approvals");
  await expect(mode).toHaveValue("approvals");
  await app.testId("settings-notifications").click();
  await expect(app.testId("settings-notifications")).not.toBeChecked();

  await app.relaunch();
  await expect(app.testId("nav-settings")).toBeVisible({ timeout: 30_000 });
  await app.testId("nav-settings").click();
  await expect(app.testId("settings-notifications")).not.toBeChecked();
  const again = app.page.locator('[data-testid="settings-agent-notify"][data-agent-name="Concierge"]');
  await expect(again).toHaveValue("approvals");

  // Turning the switch on for the first time shows one notification, which makes macOS ask for permission.
  await app.testId("settings-notifications").click();
  await expect(app.testId("settings-notifications")).toBeChecked();
  await expect.poll(async () => (await app.notifications()).map((n) => n.kind)).toEqual(["hello"]);
});

test("a person's new message notifies quietly; the history a bridge backfills does not", async ({ app }) => {
  await app.signIn();
  await app.connect("demo", "demo");
  await app.gotoInbox();
  for (const name of ["Mom", "Leo Park", "Book Club"]) await expect(app.row(name)).toBeVisible({ timeout: 30_000 });
  await app.testId("nav-tasks").click();

  // The starting messages arrive after the first sync, but with their old timestamps: history.
  await demoIncoming(await app.matrixUserId(), "mom", "mom", "Call me when you land");
  await expect.poll(() => app.notifications()).toEqual([
    {
      kind: "message",
      priority: "low",
      title: "Mom",
      body: "Call me when you land",
      open: { view: "inbox", roomId: expect.stringMatching(/^!/) },
      roomId: expect.stringMatching(/^!/),
    },
  ]);
});
