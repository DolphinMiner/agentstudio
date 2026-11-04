// The `app` fixture: one fresh client per test, either the built Electron app
// (project "desktop") or the mobile web build in an emulated iPhone
// (project "mobile-web"). Specs drive both through the same helpers and select
// elements only by the data-testid contract in docs/clients.md.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _electron as electron,
  expect,
  test as base,
  type Browser,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";
import { REPO_ROOT, SERVER_URL, outbox, uniqueEmail, waitForCode } from "./stack";

export type Platform = "desktop" | "mobile";

export const DESKTOP_APP_DIR = join(REPO_ROOT, "apps", "desktop");

/** Where e2e/fakes/agents.ts listens (see playwright.config.ts). */
export const FAKES_URL = `http://127.0.0.1:${process.env.FAKE_AGENTS_PORT ?? 18410}`;

/** A notification the desktop app asked to show (recorded instead of shown in tests; see apps/desktop/src/main/notifications.ts). */
export type ShownNotification = {
  kind: "approval" | "agent_message" | "agent_problem" | "message" | "hello";
  priority: "high" | "normal" | "low";
  title: string;
  body: string;
  open: { view: string; roomId?: string };
  roomId?: string;
};

type NotificationLog = { shown: (ShownNotification & { at: number })[]; badge: number; click(i: number): void };

// The app records notifications in globalThis.__agentStudioNotifications of the
// main process (test mode). evaluate() runs its function there, so each one
// reads it inline (it cannot call helpers defined here).
type MainGlobal = { __agentStudioNotifications: NotificationLog };

/** Starts the built desktop app on a profile directory. */
async function launchDesktop(profile: string, extraEnv: Record<string, string> = {}): Promise<{ electronApp: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.ELECTRON_RUN_AS_NODE;
  const electronApp = await electron.launch({
    args: [DESKTOP_APP_DIR],
    env: {
      ...env,
      AGENTSTUDIO_USER_DATA_DIR: profile,
      AGENTSTUDIO_SERVER_URL: SERVER_URL,
      AGENTSTUDIO_MOCK_KEYCHAIN: "1",
      // Each test signs in with its own email; the dev stack's local mode would otherwise sign every app into one account.
      AGENTSTUDIO_EMAIL_SIGNIN: "1",
      // Notifications are recorded in the main process instead of shown.
      AGENTSTUDIO_TEST_NOTIFICATIONS: "1",
      // "Export diagnostics" writes here instead of asking where.
      AGENTSTUDIO_TEST_DIAGNOSTICS_DIR: profile,
      // Connectors: a free local port per app, and the fake services instead of the real ones.
      AGENTSTUDIO_CONNECTOR_PORT: "0",
      AGENTSTUDIO_CONNECTOR_OPEN_IN_WINDOW: "1",
      AGENTSTUDIO_GROKBOT_API_URL: `${FAKES_URL}/grok/api`,
      AGENTSTUDIO_GROKBOT_WEB_URL: `${FAKES_URL}/grok/web`,
      AGENTSTUDIO_GROKBOT_POLL_MS: "300",
      // Grok Bot avatars are drawn with the installed Grok Bot app's shapes. Tests run
      // without it (the Grok Bot icon) unless E2E_GROKBOT_APP points at the app.
      AGENTSTUDIO_GROKBOT_APP: process.env.E2E_GROKBOT_APP ?? "",
      AGENTSTUDIO_CUE_API_URL: `${FAKES_URL}/cue`,
      AGENTSTUDIO_CUE_WEB_URL: `${FAKES_URL}/cue-web`,
      AGENTSTUDIO_CUE_RPC_URL: `${FAKES_URL}/cue-rpc`,
      AGENTSTUDIO_CUE_POLL_MS: "300",
      AGENTSTUDIO_WEBCHAT_GRACE_MS: "2000",
      AGENTSTUDIO_MUSE_URL: `${FAKES_URL}/muse/`,
      AGENTSTUDIO_DOTS_URL: `${FAKES_URL}/dots/`,
      ...extraEnv,
    },
  });
  return { electronApp, page: await electronApp.firstWindow() };
}

export class App {
  constructor(
    public page: Page,
    readonly platform: Platform,
    /** The Electron app (desktop only), for windows the app opens besides the main one. */
    public electron?: ElectronApplication,
    /** The desktop profile directory (desktop only). */
    readonly profile?: string,
  ) {}

  /** The email this client signed in with (set by signIn). */
  email = "";

  testId(id: string): Locator {
    return this.page.getByTestId(id);
  }

  /** A row in the chat list, by room name. */
  row(name: string): Locator {
    return this.page.locator(`[data-testid="chat-row"][data-room-name="${name}"]`);
  }

  /** Messages in the open chat, optionally only those from a sender / own. */
  messages(opts: { sender?: string; own?: boolean } = {}): Locator {
    let sel = '[data-testid="message"]';
    if (opts.own !== undefined) sel += `[data-own="${opts.own}"]`;
    if (opts.sender) sel += `[data-sender="${opts.sender}"]`;
    return this.page.locator(sel).filter({ visible: true });
  }

  /** The message whose body is exactly `text`, in the visible chat. */
  message(text: string, opts: { sender?: string; own?: boolean } = {}): Locator {
    return this.messages(opts).filter({ has: this.page.getByTestId("message-body").getByText(text, { exact: true }) });
  }

  /** Signs in through the UI with a fresh (or given) email; ends on the inbox. */
  async signIn(email = uniqueEmail(this.platform)): Promise<string> {
    const seen = (await outbox(email)).length;
    await this.testId("signin-email").fill(email);
    await this.testId("signin-send").click();
    await expect(this.testId("signin-code")).toBeVisible();
    await this.testId("signin-code").fill(await waitForCode(email, seen));
    await this.testId("signin-verify").click();
    await expect(this.testId("nav-inbox")).toBeVisible();
    this.email = email;
    return email;
  }

  async signOut(): Promise<void> {
    await this.testId("nav-settings").click();
    await this.visible("settings-signout").click();
    // The email form, or (local mode) "Continue on this Mac".
    await expect(this.page.locator('[data-testid="signin-email"], [data-testid="signin-local"]')).toBeVisible();
  }

  /** The visible element with a test id (mobile keeps inactive tabs mounted but hidden). */
  visible(id: string): Locator {
    return this.testId(id).filter({ visible: true });
  }

  /** Shows the chat list (on mobile this leaves an open chat). */
  async gotoInbox(): Promise<void> {
    await this.testId("nav-inbox").click();
    const list = this.visible("chat-list").or(this.visible("inbox-empty")).first();
    if (this.platform === "mobile") {
      // Tapping the active Inbox tab may already pop the chat; otherwise go back.
      await expect(async () => {
        const back = this.visible("chat-back");
        if (await back.count()) await back.click({ timeout: 1_000 });
        await expect(list).toBeVisible({ timeout: 1_000 });
      }).toPass();
    }
    await expect(list).toBeVisible();
  }

  /** Opens a chat from the inbox and waits for its header. */
  async openChat(name: string): Promise<void> {
    await this.gotoInbox();
    await this.row(name).click();
    await expect(this.visible("chat-title")).toHaveText(name);
  }

  async send(text: string): Promise<void> {
    await this.visible("composer-input").fill(text);
    await this.visible("composer-send").click();
    await expect(this.message(text, { own: true }).last()).toBeVisible();
  }

  /** Opens a message's actions (hover on desktop; mobile web shows the button) and picks "Ask an agent". */
  async askAbout(message: Locator): Promise<void> {
    if (this.platform === "desktop") await message.hover();
    await message.getByTestId("message-ask").click();
    await expect(this.testId("ask-send")).toBeVisible();
  }

  /** Connects a network through the Connect screen, ending on its complete step. */
  async connect(network: string, flow: string): Promise<void> {
    await this.testId("nav-connect").click();
    await this.visible(`network-${network}`).click();
    await this.visible(`flow-${flow}`).click();
    const done = this.visible("login-complete");
    const step = this.visible("login-step");
    await expect(done.or(step).first()).toBeVisible();
    if (!(await done.count()) && (await step.getAttribute("data-step-type")) === "user_input") {
      await this.visible("login-submit").click();
    }
    await expect(done).toBeVisible({ timeout: 30_000 });
  }

  /** Connects a network flow whose first step asks for input; `fields` maps field ids to values. */
  async connectWith(network: string, flow: string, fields: Record<string, string>): Promise<void> {
    await this.testId("nav-connect").click();
    await this.visible(`network-${network}`).click();
    await this.visible(`flow-${flow}`).click();
    await expect(this.visible("login-step")).toHaveAttribute("data-step-type", "user_input");
    for (const [id, value] of Object.entries(fields)) await this.visible(`login-field-${id}`).fill(value);
    await this.visible("login-submit").click();
    await expect(this.visible("login-complete")).toBeVisible({ timeout: 30_000 });
  }

  /** A window of the desktop app (besides the main one) whose URL or document title matches. */
  async window(title: RegExp): Promise<Page> {
    const app = this.electron;
    if (!app) throw new Error("desktop only");
    let found: Page | undefined;
    await expect(async () => {
      found = undefined;
      for (const w of app.windows()) {
        if (w === this.page || w.isClosed()) continue;
        if (title.test(w.url()) || title.test(await w.title().catch(() => ""))) found = w;
      }
      expect(found, `a window titled ${title}`).toBeTruthy();
    }).toPass({ timeout: 20_000 });
    return found!;
  }

  /** Notifications the desktop app asked to show so far (desktop only). */
  async notifications(): Promise<ShownNotification[]> {
    // Drop the recording time so tests can compare whole notifications.
    return this.desktopMain().evaluate(() =>
      (globalThis as unknown as MainGlobal).__agentStudioNotifications.shown.map(({ at: _at, ...n }) => n),
    );
  }

  /** The Dock badge count the desktop app set (desktop only). */
  async badge(): Promise<number> {
    return this.desktopMain().evaluate(() => (globalThis as unknown as MainGlobal).__agentStudioNotifications.badge);
  }

  /** Acts as if the user clicked the i-th notification (desktop only). */
  async clickNotification(i: number): Promise<void> {
    await this.desktopMain().evaluate((_electron, index) => (globalThis as unknown as MainGlobal).__agentStudioNotifications.click(index), i);
  }

  private desktopMain(): ElectronApplication {
    if (!this.electron) throw new Error("desktop only");
    return this.electron;
  }

  /** Quits the desktop app and starts it again on the same profile (desktop only). */
  async relaunch(env: Record<string, string> = {}): Promise<void> {
    if (!this.electron || !this.profile) throw new Error("desktop only");
    await this.electron.close();
    const { electronApp, page } = await launchDesktop(this.profile, env);
    this.electron = electronApp;
    this.page = page;
  }

  /** The signed-in user's session as the client persisted it. */
  async session(): Promise<{ access_token: string; matrix: { homeserver_url: string; user_id: string; access_token: string } }> {
    const s = await this.page.evaluate(async () => {
      const g = globalThis as unknown as { agentStudioDesktop?: { session: { load(): Promise<unknown> } } };
      if (g.agentStudioDesktop) return g.agentStudioDesktop.session.load();
      const raw = globalThis.localStorage.getItem("agentstudio.session");
      return raw ? JSON.parse(raw) : null;
    });
    if (!s) throw new Error("no persisted session");
    return s as Awaited<ReturnType<App["session"]>>;
  }

  /** The signed-in user's Matrix ID, read from the client's persisted session. */
  async matrixUserId(): Promise<string> {
    const id = await this.page.evaluate(async () => {
      const g = globalThis as unknown as {
        agentStudioDesktop?: { session: { load(): Promise<{ matrix: { user_id: string } } | null> } };
      };
      if (g.agentStudioDesktop) return (await g.agentStudioDesktop.session.load())?.matrix.user_id ?? null;
      const raw = globalThis.localStorage.getItem("agentstudio.session");
      return raw ? (JSON.parse(raw) as { matrix: { user_id: string } }).matrix.user_id : null;
    });
    if (!id) throw new Error("no persisted session");
    return id;
  }
}

type Fixtures = { platform: Platform; app: App };

export const test = base.extend<Fixtures>({
  platform: ["desktop", { option: true }],

  app: async ({ platform, playwright }, use, testInfo) => {
    let page: Page;
    let cleanup: () => Promise<void>;
    let electronRef: ElectronApplication | undefined;
    let profileDir: string | undefined;
    let app: App | undefined;
    if (platform === "desktop") {
      const profile = mkdtempSync(join(tmpdir(), "agentstudio-e2e-"));
      profileDir = profile;
      const { electronApp } = await launchDesktop(profile);
      electronRef = electronApp;
      page = await electronApp.firstWindow();
      cleanup = async () => {
        // The test may have relaunched the app (App.relaunch); close the current one.
        await (app?.electron ?? electronApp).close().catch(() => undefined);
        rmSync(profile, { recursive: true, force: true });
      };
    } else {
      const browser: Browser = await playwright.chromium.launch();
      const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, baseURL } = testInfo.project.use;
      const context = await browser.newContext({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, baseURL });
      page = await context.newPage();
      await page.goto("/");
      cleanup = async () => {
        await browser.close().catch(() => undefined);
      };
    }
    page.on("pageerror", (e) => console.log(`[${platform} page error]`, e.message));
    await expect(page.getByTestId("signin-email")).toBeVisible({ timeout: 30_000 });
    app = new App(page, platform, electronRef, profileDir);
    await use(app);
    if (testInfo.status !== testInfo.expectedStatus) {
      const shot = await app.page.screenshot().catch(() => null);
      if (shot) await testInfo.attach("screenshot", { body: shot, contentType: "image/png" });
    }
    await cleanup();
  },
});

export { expect };
