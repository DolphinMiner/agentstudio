// Desktop smoke test: launches the built Electron app with a fresh profile and
// walks the main flows against the running local stack.

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const SERVER = process.env.AGENTSTUDIO_SERVER_URL ?? "http://127.0.0.1:18090";
// Launch the package directory so Electron reads package.json (name, version, main).
const APP_DIR = join(__dirname, "..");
const ARTIFACTS = join(__dirname, "artifacts");
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const EMAIL = `desktop-smoke-${run}@example.com`;

let profileDir: string;
let app: ElectronApplication;
let page: Page;

async function launch(): Promise<void> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    args: [APP_DIR],
    env: { ...env, AGENTSTUDIO_USER_DATA_DIR: profileDir, AGENTSTUDIO_SERVER_URL: SERVER, AGENTSTUDIO_MOCK_KEYCHAIN: "1" },
  });
  page = await app.firstWindow();
  page.on("pageerror", (e) => console.log("[renderer error]", e.message));
}

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

test.beforeAll(async () => {
  const health = await fetch(`${SERVER}/v1/health`).then((r) => r.json() as Promise<{ ok: boolean }>);
  expect(health.ok, "local stack must be running (pnpm dev:up)").toBe(true);
  profileDir = mkdtempSync(join(tmpdir(), "agentstudio-desktop-smoke-"));
  await launch();
});

test.afterAll(async () => {
  await app?.close();
  if (profileDir) rmSync(profileDir, { recursive: true, force: true });
});

test("window is locked down", async () => {
  const info = await page.evaluate(() => ({
    hasRequire: typeof (globalThis as { require?: unknown }).require !== "undefined",
    hasProcess: typeof (globalThis as { process?: unknown }).process !== "undefined",
    bridge: Object.keys((globalThis as unknown as { agentStudioDesktop: object }).agentStudioDesktop).sort(),
    server: (globalThis as unknown as { agentStudioDesktop: { getServerUrl(): string } }).agentStudioDesktop.getServerUrl(),
  }));
  expect(info.hasRequire).toBe(false);
  expect(info.hasProcess).toBe(false);
  expect(info.bridge).toEqual(
    ["connectors", "getServerUrl", "notifications", "openExternal", "platform", "serverUrlFromEnv", "session", "setServerUrl", "version"].sort(),
  );
  expect(info.server).toBe(SERVER);
  // The CSP only allows the configured server origin: other origins raise a violation.
  const violated = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        document.addEventListener("securitypolicyviolation", (e) => resolve(e.violatedDirective), { once: true });
        fetch("http://127.0.0.1:18008/_matrix/client/versions").catch(() => undefined);
        setTimeout(() => resolve("none"), 3000);
      }),
  );
  expect(violated).toBe("connect-src");
  const allowed = await page.evaluate((s) => fetch(`${s}/v1/health`).then((r) => r.ok), SERVER);
  expect(allowed).toBe(true);
});

test("sign in with an emailed code", async () => {
  await page.getByTestId("signin-email").fill(EMAIL);
  await page.getByTestId("signin-send").click();
  await expect(page.getByTestId("signin-code")).toBeVisible();
  // A wrong code shows an error first.
  await page.getByTestId("signin-code").fill("000000");
  await page.getByTestId("signin-verify").click();
  await expect(page.getByTestId("signin-error")).toBeVisible();
  await page.getByTestId("signin-code").fill(await signInCode(EMAIL));
  await page.getByTestId("signin-verify").click();
  await expect(page.getByTestId("nav-inbox")).toBeVisible();
  await expect(page.getByTestId("inbox-empty")).toBeVisible();
  await shot("01-inbox-empty");
});

test("connect Demo and see the three demo chats", async () => {
  await page.getByTestId("nav-connect").click();
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
});

test("open Leo Park, send a message, get the echo", async () => {
  await row("Leo Park").click();
  await expect(page.getByTestId("chat-title")).toHaveText("Leo Park");
  await expect(page.getByTestId("chat-network")).toHaveText("Demo");
  await expect(page.getByTestId("message-body").filter({ hasText: "Are we still on for 7:15?" })).toBeVisible();
  const text = `hello from smoke ${run}`;
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-send").click();
  await expect(page.locator('[data-testid="message"][data-own="true"]').getByTestId("message-body").last()).toHaveText(text);
  const echo = page.locator('[data-testid="message"][data-own="false"][data-sender="Leo Park"]').getByTestId("message-body").filter({ hasText: `Echo: ${text}` });
  await expect(echo).toBeVisible();
  await shot("03-chat-echo");
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
  await anchor.hover();
  await anchor.getByTestId("message-ask").click();
  await expect(page.getByTestId("ask-agent-Concierge")).toBeVisible();
  await expect(page.getByTestId("ask-request")).toHaveValue("Draft a reply");
  await expect(page.getByTestId("ask-line").last()).toContainText("Are we still on for 7:15?");
  await shot("04-ask-modal");
  await page.getByTestId("ask-send").click();

  await expect(page.getByTestId("chat-title")).toHaveText("Concierge");
  const drafts = page.getByTestId("drafts-card").last();
  await expect(drafts).toBeVisible({ timeout: 30_000 });
  await expect(drafts.getByTestId("draft-item").first()).toContainText("Leo, sounds good, see you then!");
  await shot("05-drafts");
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
  await shot("06-tasks");
});

test("approval card: flight request, approve, badge clears", async () => {
  await page.getByTestId("nav-inbox").click();
  await row("Concierge").click();
  await page.getByTestId("composer-input").fill("Find me a flight to Toronto");
  await page.getByTestId("composer-send").click();
  const card = page.getByTestId("approval-card").last();
  await expect(card.getByTestId("approval-title")).toHaveText("Book the 6pm flight to Toronto for $412?");
  await expect(card.getByTestId("approval-detail")).toHaveCount(3);
  await expect(card.getByTestId("approval-expiry")).toHaveText(/min left/);
  await expect(page.getByTestId("nav-approvals-badge")).toHaveText("1");
  await page.getByTestId("nav-approvals").click();
  await expect(page.getByTestId("approvals-list").getByTestId("approval-card")).toHaveCount(1);
  await shot("07-approvals");
  await page.getByTestId("approval-choice-book").click();
  await expect(page.getByTestId("approval-state")).toHaveText("Approved: Book");
  await expect(page.getByTestId("nav-approvals-badge")).toHaveCount(0);
  await expect(row("Concierge").getByTestId("chat-row-needs-you")).toHaveCount(0);
  await page.getByTestId("nav-inbox").click();
  await row("Concierge").click();
  await expect(page.getByTestId("message-body").filter({ hasText: "Booked. Seat 14A, confirmation PCH412." })).toBeVisible();
  await expect(page.getByTestId("approval-card").last().getByTestId("approval-state")).toHaveText("Approved: Book");
  await shot("08-approved-in-chat");
});

test("settings show the account; session survives a restart; sign out", async () => {
  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("settings-email")).toHaveText(EMAIL);
  await expect(page.getByTestId("settings-server")).toHaveValue(SERVER);
  await expect(page.getByTestId("settings-version")).toHaveText("0.1.0");
  await shot("09-settings");

  await app.close();
  await launch();
  await expect(page.getByTestId("nav-inbox")).toBeVisible();
  await expect(row("Leo Park")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-signout").click();
  await expect(page.getByTestId("signin-email")).toBeVisible();
});
