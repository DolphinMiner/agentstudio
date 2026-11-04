// Mobile web smoke test: signs in with a code from the dev outbox, connects the
// Demo network, opens Leo Park, sends a message and waits for the echo.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const SERVER = process.env.AGENTSTUDIO_SERVER_URL ?? "http://127.0.0.1:18090";
const ARTIFACTS = join(__dirname, "artifacts");
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const EMAIL = `mobile-smoke-${run}@example.com`;

let page: Page;

async function signInCode(email: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`${SERVER}/v1/dev/outbox?email=${encodeURIComponent(email)}`);
    if (res.ok) {
      const body = (await res.json()) as { messages: { code: string }[] };
      if (body.messages[0]?.code) return body.messages[0].code;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("no sign-in code in the dev outbox");
}

function row(name: string) {
  return page.locator(`[data-testid="chat-row"][data-room-name="${name}"]`);
}

async function shot(name: string) {
  mkdirSync(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: join(ARTIFACTS, `${name}.png`) });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  const health = await fetch(`${SERVER}/v1/health`).then((r) => r.json() as Promise<{ ok: boolean }>);
  expect(health.ok, "local stack must be running (pnpm dev:up)").toBe(true);
  // A fresh context means fresh localStorage, i.e. a fresh session.
  const ctx = await browser.newContext(test.info().project.use);
  page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[page error]", e.message));
  await page.goto("/");
});

test.afterAll(async () => {
  await page?.context().close();
});

test("sign in with an emailed code", async () => {
  await page.getByTestId("signin-email").fill(EMAIL);
  await page.getByTestId("signin-send").click();
  await expect(page.getByTestId("signin-code")).toBeVisible();
  await page.getByTestId("signin-code").fill("000000");
  await page.getByTestId("signin-verify").click();
  await expect(page.getByTestId("signin-error")).toBeVisible();
  await shot("00-signin-error");
  await page.getByTestId("signin-code").fill(await signInCode(EMAIL));
  await page.getByTestId("signin-verify").click();
  await expect(page.getByTestId("nav-inbox")).toBeVisible();
  await expect(page.getByTestId("inbox-empty")).toBeVisible();
  await shot("01-inbox-empty");
});

test("connect Demo and see the three demo chats", async () => {
  await page.getByTestId("inbox-connect").click();
  await page.getByTestId("network-demo").click();
  await page.getByTestId("flow-demo").click();
  await expect(page.getByTestId("login-step")).toHaveAttribute("data-step-type", "user_input");
  await expect(page.getByTestId("login-field-display_name")).toHaveValue("Demo User");
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("login-complete")).toBeVisible();
  await expect(page.locator('[data-testid="connection-row"][data-network="demo"]')).toBeVisible();
  await shot("02-connect");

  await page.getByTestId("nav-inbox").click();
  for (const name of ["Mom", "Leo Park", "Book Club"]) await expect(row(name)).toBeVisible({ timeout: 30_000 });
  await expect(row("Leo Park").getByTestId("chat-row-network")).toHaveText("Demo");
  await expect(row("Leo Park").getByTestId("chat-row-name")).toHaveText("Leo Park");
  await expect(page.getByRole("button", { name: "Leo Park", exact: true })).toBeVisible();
  await shot("03-inbox");
});

test("open Leo Park, send a message, get the echo", async () => {
  await row("Leo Park").click();
  await expect(page.getByTestId("chat-title")).toHaveText("Leo Park");
  await expect(page.getByTestId("chat-network")).toHaveText("Demo");
  await expect(page.getByTestId("message-body").filter({ hasText: "Are we still on for 7:15?" })).toBeVisible();
  const text = `hello from mobile ${run}`;
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-send").click();
  await expect(page.locator('[data-testid="message"][data-own="true"]').getByTestId("message-body").filter({ hasText: text })).toBeVisible();
  const echo = page
    .locator('[data-testid="message"][data-own="false"][data-sender="Leo Park"]')
    .getByTestId("message-body")
    .filter({ hasText: `Echo: ${text}` });
  await expect(echo).toBeVisible();
  await expect(page.getByTestId("composer-input")).toHaveValue("");
  await shot("04-chat-echo");

  await page.getByTestId("chat-back").click();
  await expect(row("Leo Park")).toBeVisible();
  // The row preview follows the latest message.
  await expect(row("Leo Park")).toContainText(`Echo: ${text}`);
  await shot("05-inbox-after-chat");
});

test("ask Concierge about a message, use a draft, task done", async () => {
  await page.getByTestId("nav-connect").click();
  await page.getByTestId("network-agentstudio-agents").click();
  await page.getByTestId("flow-concierge").click();
  const step = page.getByTestId("login-step");
  await expect(step).toBeVisible();
  if ((await step.getAttribute("data-step-type")) === "user_input") await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("login-complete")).toBeVisible();
  await page.getByTestId("nav-inbox").click();
  await expect(row("Concierge")).toBeVisible({ timeout: 30_000 });
  await expect(row("Concierge").getByTestId("chat-row-network")).toHaveText("Agent");

  await row("Leo Park").click();
  const anchor = page.locator('[data-testid="message"]').filter({ hasText: "Are we still on for 7:15?" });
  await anchor.getByTestId("message-ask").click();
  await expect(page.getByTestId("ask-agent-Concierge")).toBeVisible();
  await expect(page.getByTestId("ask-request")).toHaveValue("Draft a reply");
  await expect(page.getByTestId("ask-line").last()).toContainText("Are we still on for 7:15?");
  await expect(page.getByTestId("ask-line-toggle").last()).toHaveAttribute("aria-checked", "true");
  await shot("07-ask-sheet");
  await page.getByTestId("ask-send").click();

  // Chat -> chat replaces, so exactly one chat is mounted.
  await expect(page.getByTestId("chat-title")).toHaveText("Concierge");
  await expect(page.getByTestId("chat-title")).toHaveCount(1);
  const drafts = page.getByTestId("drafts-card").last();
  await expect(drafts).toBeVisible({ timeout: 30_000 });
  await expect(drafts.getByTestId("draft-item").first()).toContainText("Leo, sounds good, see you then!");
  await shot("08-drafts");
  await drafts.getByTestId("draft-use").first().click();

  await expect(page.getByTestId("chat-title")).toHaveText("Leo Park");
  await expect(page.getByTestId("composer-input")).toHaveValue("Leo, sounds good, see you then!");
  await page.getByTestId("composer-send").click();
  await expect(
    page.locator('[data-testid="message"][data-sender="Leo Park"]').filter({ hasText: "Echo: Leo, sounds good, see you then!" }),
  ).toBeVisible();

  await page.getByTestId("nav-tasks").click();
  await expect(page.getByTestId("tasks-board")).toBeVisible();
  await expect(page.getByTestId("tasks-col-done").locator('[data-testid="task-card"][data-state="done"]')).toHaveCount(1);
  await shot("09-tasks");
});

test("approval card: flight request, approve, badge clears", async () => {
  await page.getByTestId("nav-inbox").click();
  await row("Concierge").click();
  // Enter sends on web.
  await page.getByTestId("composer-input").fill("Find me a flight to Toronto");
  await page.getByTestId("composer-input").press("Enter");
  await expect(page.getByTestId("composer-input")).toHaveValue("");
  const card = page.getByTestId("approval-card").last();
  await expect(card.getByTestId("approval-title")).toHaveText("Book the 6pm flight to Toronto for $412?");
  await expect(card.getByTestId("approval-detail")).toHaveCount(3);
  await expect(card.getByTestId("approval-expiry")).toHaveText(/min left/);
  await expect(page.getByTestId("nav-approvals-badge")).toHaveText("1");
  await shot("10-approval-in-chat");
  await page.getByTestId("nav-approvals").click();
  await expect(page.getByTestId("approvals-list").getByTestId("approval-card")).toHaveCount(1);
  await shot("11-approvals");
  await page.getByTestId("approval-choice-book").click();
  await expect(page.getByTestId("approvals-list").getByTestId("approval-state")).toHaveText("Approved: Book");
  await expect(page.getByTestId("nav-approvals-badge")).toHaveCount(0);
  await page.getByTestId("nav-inbox").click();
  await expect(row("Concierge").getByTestId("chat-row-needs-you")).toHaveCount(0);
  await row("Concierge").click();
  await expect(page.getByTestId("message-body").filter({ hasText: "Booked. Seat 14A, confirmation PCH412." })).toBeVisible();
  await expect(page.getByTestId("approval-card").last().getByTestId("approval-state")).toHaveText("Approved: Book");
  await shot("12-approved-in-chat");
});

test("settings; session survives a reload; sign out", async () => {
  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("settings-email")).toHaveText(EMAIL);
  await expect(page.getByTestId("settings-server")).toHaveValue(SERVER);
  await expect(page.getByTestId("settings-version")).toHaveText("0.1.0");
  await shot("06-settings");

  await page.reload();
  await expect(page.getByTestId("nav-inbox")).toBeVisible();
  await expect(row("Leo Park")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-signout").click();
  await expect(page.getByTestId("signin-email")).toBeVisible();
});
