import { expect, test } from "../support/app";
import { demoIncoming } from "../support/stack";

test("demo network: chats, ordering, echo and an injected incoming message", async ({ app }) => {
  await app.signIn();
  await app.connect("demo", "demo");

  await app.gotoInbox();
  for (const name of ["Mom", "Leo Park", "Book Club"]) {
    await expect(app.row(name)).toBeVisible({ timeout: 30_000 });
    await expect(app.row(name).getByTestId("chat-row-network")).toHaveText("Demo");
  }

  // Read Mom's chat so its backfilled message no longer counts as unread.
  await app.openChat("Mom");
  await expect(app.message("Did you eat yet?", { sender: "Mom" })).toBeVisible();

  await app.openChat("Leo Park");
  await expect(app.visible("chat-network")).toHaveText("Demo");
  const first = app.message("Hey! Long time", { sender: "Leo Park" });
  const second = app.message("Are we still on for 7:15?", { sender: "Leo Park" });
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  // Starting messages are shown oldest first (top to bottom), whatever the DOM order.
  const [a, b] = [await first.boundingBox(), await second.boundingBox()];
  expect(a && b && a.y < b.y, "Hey! Long time is above Are we still on for 7:15?").toBe(true);

  await app.send("hello from e2e");
  const own = app.message("hello from e2e", { own: true });
  const echo = app.message("Echo: hello from e2e", { sender: "Leo Park", own: false });
  await expect(echo).toBeVisible();
  const [o, e] = [await own.last().boundingBox(), await echo.last().boundingBox()];
  expect(o && e && o.y < e.y, "own message is above the echo").toBe(true);

  // An incoming message for a chat that is not open shows up unread in the inbox.
  await app.gotoInbox();
  const mom = app.row("Mom");
  await expect(mom.getByTestId("chat-row-unread")).toHaveCount(0);
  await demoIncoming(await app.matrixUserId(), "mom", "mom", "Call me when you land");
  await expect(mom.getByTestId("chat-row-unread")).toHaveText("1");
  await expect(mom).toContainText("Call me when you land");
});
