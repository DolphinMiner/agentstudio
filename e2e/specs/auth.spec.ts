import { expect, test } from "../support/app";

test("sign in, sign out and sign back in", async ({ app }) => {
  const email = await app.signIn();
  await expect(app.visible("inbox-empty")).toBeVisible();
  await expect(app.visible("inbox-connect")).toBeVisible();

  await app.testId("nav-settings").click();
  await expect(app.visible("settings-email")).toHaveText(email);
  await app.signOut();

  // The same account again; the code from the first sign-in was consumed, so no resend throttle.
  await app.signIn(email);
  await expect(app.visible("inbox-empty")).toBeVisible();
  await app.testId("nav-settings").click();
  await expect(app.visible("settings-email")).toHaveText(email);
});

test("a wrong code shows an error", async ({ app }) => {
  await app.testId("signin-email").fill(`e2e-wrong-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@example.com`);
  await app.testId("signin-send").click();
  await expect(app.testId("signin-code")).toBeVisible();
  await app.testId("signin-code").fill("000000");
  await app.testId("signin-verify").click();
  await expect(app.testId("signin-error")).toBeVisible();
  await expect(app.testId("nav-inbox")).toHaveCount(0);
});

test("on this Mac: the app starts signed in, and Continue on this Mac after signing out", async ({ app, platform }) => {
  test.skip(platform !== "desktop", "local mode is the Mac app's");
  // The dev stack runs in local mode. Without the tests' email-only switch, the app signs straight in.
  await app.relaunch({ AGENTSTUDIO_EMAIL_SIGNIN: "" });
  await expect(app.testId("nav-inbox")).toBeVisible({ timeout: 30_000 });
  await app.testId("nav-settings").click();
  await expect(app.visible("settings-email")).toHaveText("You, on this Mac");

  // Signing out doesn't sign straight back in; one click does.
  await app.signOut();
  await expect(app.testId("signin-local")).toBeVisible();
  await expect(app.testId("nav-inbox")).toHaveCount(0);
  await app.testId("signin-local").click();
  await expect(app.testId("nav-inbox")).toBeVisible();
  // The same account as before, so its chats are still there.
  await app.testId("nav-settings").click();
  await expect(app.visible("settings-email")).toHaveText("You, on this Mac");
});
