// Records the README's demo video and screenshots: the desktop app on fake
// data (the demo network, and Grok Bot, Cue, Muse and Dots through
// e2e/fakes/agents.ts). Writes e2e/media/out/: frames/ (the screencast),
// scenes.json (when each caption starts) and shots/ (full-resolution
// screenshots). render.mjs turns these into docs/media.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CDPSession, Locator, Page } from "@playwright/test";
import { expect, test } from "../support/app";
import type { App } from "../support/app";

const OUT = join(__dirname, "out");
const FRAMES = join(OUT, "frames");
const SHOTS = join(OUT, "shots");

/** A pointer drawn into the page, so the video shows where the clicks go. */
const CURSOR = `(() => {
  if (document.getElementById("media-cursor")) return;
  const c = document.createElement("div");
  c.id = "media-cursor";
  c.innerHTML = '<svg width="26" height="26" viewBox="0 0 26 26"><path d="M5 3l15 9.2-6.6 1.4 3.9 7.4-3 1.6-3.9-7.5L5 20z" fill="#111827" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  Object.assign(c.style, { position: "fixed", left: "0", top: "0", zIndex: "2147483647", pointerEvents: "none", transform: "translate(-200px,-200px)", filter: "drop-shadow(0 2px 3px rgba(0,0,0,.25))" });
  const ring = document.createElement("div");
  Object.assign(ring.style, { position: "fixed", width: "36px", height: "36px", margin: "-18px 0 0 -18px", borderRadius: "50%", background: "rgba(242,169,59,.35)", border: "2px solid rgba(242,169,59,.9)", zIndex: "2147483646", pointerEvents: "none", opacity: "0", transition: "opacity .35s, transform .35s" });
  document.body.append(ring, c);
  addEventListener("mousemove", (e) => { c.style.transform = "translate(" + (e.clientX - 5) + "px," + (e.clientY - 3) + "px)"; }, true);
  addEventListener("mousedown", (e) => {
    Object.assign(ring.style, { left: e.clientX + "px", top: e.clientY + "px", transition: "none", opacity: "1", transform: "scale(.4)" });
    requestAnimationFrame(() => requestAnimationFrame(() => Object.assign(ring.style, { transition: "opacity .45s, transform .45s", opacity: "0", transform: "scale(1.3)" })));
  }, true);
})()`;

/** Records the window with the DevTools screencast; frames are kept with their times. */
class Recorder {
  private cdp: CDPSession | null = null;
  private frames: { file: string; at: number }[] = [];
  private scenes: { caption: string; at: number }[] = [];
  private t0 = 0;

  constructor(private page: Page) {}

  async start() {
    rmSync(FRAMES, { recursive: true, force: true });
    mkdirSync(FRAMES, { recursive: true });
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.t0 = Date.now() / 1000;
    this.cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
      const file = `${String(this.frames.length).padStart(5, "0")}.jpg`;
      writeFileSync(join(FRAMES, file), Buffer.from(f.data, "base64"));
      this.frames.push({ file, at: f.metadata.timestamp ?? Date.now() / 1000 });
      void this.cdp?.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined);
    });
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 98, maxWidth: 2560, maxHeight: 1600, everyNthFrame: 1 });
  }

  /** A caption for what follows. */
  scene(caption: string) {
    this.scenes.push({ caption, at: Date.now() / 1000 - this.t0 });
  }

  async stop() {
    await this.cdp?.send("Page.stopScreencast");
    await this.cdp?.detach();
    const end = Date.now() / 1000;
    const t0 = this.frames[0]?.at ?? this.t0;
    writeFileSync(
      join(OUT, "scenes.json"),
      JSON.stringify({
        duration: end - t0,
        frames: this.frames.map((f) => ({ file: f.file, at: f.at - t0 })),
        // Scene times were taken on the wall clock from t0; frame times are the compositor's.
        scenes: this.scenes.map((s) => ({ caption: s.caption, at: Math.max(0, s.at - (t0 - this.t0)) })),
      }, null, 2),
    );
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Glides the pointer to an element, then clicks it. */
async function click(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 28 });
  await pause(180);
  await target.click();
}

async function hover(page: Page, target: Locator) {
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + Math.min(box.width / 2, 160), box.y + box.height / 2, { steps: 28 });
  await target.hover();
}

/** Types into the composer at a readable pace and sends. */
async function say(app: App, text: string) {
  const input = app.visible("composer-input");
  await click(app.page, input);
  await input.pressSequentially(text, { delay: 38 });
  await pause(250);
  await click(app.page, app.visible("composer-send"));
  await expect(app.message(text, { own: true }).last()).toBeVisible();
}

/** A full-resolution screenshot, without the drawn pointer. */
async function shot(app: App, name: string) {
  await pause(400);
  const cursor = app.page.locator("#media-cursor");
  await cursor.evaluate((c) => (c.style.visibility = "hidden"));
  await app.page.screenshot({ path: join(SHOTS, `${name}.png`) });
  await cursor.evaluate((c) => (c.style.visibility = ""));
}

async function signInWindow(app: App, url: RegExp) {
  const win = await app.window(url);
  await win.locator("#login").click();
}

async function connectLocal(app: App, service: string, signIn?: () => Promise<void>) {
  await app.testId("nav-connect").click();
  await app.visible(`local-service-${service}`).click();
  await signIn?.();
  await expect(app.testId("local-login")).toHaveCount(0, { timeout: 60_000 });
  await expect(app.testId("local-login-error")).toHaveCount(0);
}

async function openRow(app: App, name: string) {
  await app.testId("nav-inbox").click();
  const row = app.row(name);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await click(app.page, row);
  await expect(app.visible("chat-title")).toHaveText(name);
}

test("README media", async ({ app }) => {
  rmSync(SHOTS, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });
  const page = app.page;
  await app.electron!.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!;
    w.setContentSize(1280, 800);
    w.center();
  });

  // ---- setup, not recorded ----
  await app.signIn();
  await app.connect("demo", "demo");
  await connectLocal(app, "grokbot");
  await connectLocal(app, "cue", async () => {
    await app.visible("local-login-action-api-key").click();
    await app.visible("local-login-input").fill(`cue-key-${Date.now()}`);
    await app.visible("local-login-submit").click();
  });
  await connectLocal(app, "muse", () => signInWindow(app, /\/muse\//));
  await connectLocal(app, "dots", () => signInWindow(app, /\/dots\//));
  // The services' pages keep running in their own (hidden) windows; bring AgentStudio to the front.
  await app.electron!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());

  await app.gotoInbox();
  await app.testId("inbox-filter-all").filter({ visible: true }).click();
  for (const name of ["Grok Helper", "Sales Bot", "Cue", "Trip Planner", "Muse", "Dots", "Leo Park", "Mom"]) {
    await expect(app.row(name)).toBeVisible({ timeout: 60_000 });
  }
  // History and avatars settle.
  await pause(4_000);
  await page.evaluate(CURSOR);
  await page.mouse.move(640, 760);

  // ---- the video ----
  const rec = new Recorder(page);
  await rec.start();
  rec.scene("Every chat and every agent, in one inbox");
  await pause(2_500);
  await shot(app, "inbox");

  rec.scene("Chat with your Grok Bot agents");
  await openRow(app, "Grok Helper");
  await say(app, "What's on my calendar tomorrow?");
  await expect(app.messages({ sender: "Grok Helper" }).filter({ hasText: "16:30 dentist" })).toBeVisible({ timeout: 15_000 });
  await pause(2_200);

  rec.scene("Agents ask before they act");
  await say(app, "Yes, prepare the report");
  const report = app.visible("approval-card").last();
  await expect(report.getByTestId("approval-title")).toHaveText("Send the weekly report to the team?");
  await pause(1_200);
  await shot(app, "grok");
  await click(page, report.getByTestId("approval-choice-send"));
  await expect(app.message("Sent the report to the team.", { sender: "Grok Helper" })).toBeVisible();
  await pause(1_500);

  rec.scene("And with your Muse");
  await openRow(app, "Muse");
  await say(app, "How is the weather this week?");
  await expect(app.messages({ sender: "Muse" }).filter({ hasText: "Take an umbrella." })).toBeVisible({ timeout: 15_000 });
  await pause(1_500);
  await say(app, "Book dinner for two on Friday");
  const dinner = app.visible("approval-card").last();
  await expect(dinner.getByTestId("approval-title")).toHaveText("I found a table for 2 at 7:30 at Nopa.", { timeout: 15_000 });
  await pause(1_200);
  await shot(app, "muse");
  await click(page, dinner.getByTestId("approval-choice-b0"));
  await expect(app.message("Booked! See you at 7:30.", { sender: "Muse" })).toBeVisible({ timeout: 15_000 });
  await pause(1_500);

  rec.scene("Ask an agent about any message");
  await openRow(app, "Leo Park");
  const anchor = app.message("Are we still on for 7:15?", { sender: "Leo Park" });
  await hover(page, anchor);
  await pause(500);
  await click(page, anchor.getByTestId("message-ask"));
  await expect(app.testId("ask-send")).toBeVisible();
  await click(page, app.visible("ask-agent-Dots"));
  await pause(900);
  await shot(app, "ask");
  await click(page, app.visible("ask-send"));
  await expect(app.visible("chat-title")).toHaveText("Dots");
  const drafts = app.visible("drafts-card").last();
  await expect(drafts.getByTestId("draft-item")).toHaveCount(3, { timeout: 30_000 });
  await pause(1_200);
  await shot(app, "drafts");
  await click(page, drafts.getByTestId("draft-use").first());
  await expect(app.visible("chat-title")).toHaveText("Leo Park");
  await pause(900);
  await click(page, app.visible("composer-send"));
  await expect(app.message("Echo: Absolutely, count me in.", { sender: "Leo Park" })).toBeVisible();
  await pause(1_500);

  rec.scene("Connect them in one click");
  await click(page, app.testId("nav-connect"));
  await expect(app.visible("local-service-manage-grokbot")).toBeVisible();
  await pause(1_800);
  await shot(app, "connect");
  await click(page, app.visible("local-service-manage-grokbot"));
  await expect(app.visible("local-sheet")).toBeVisible();
  await pause(2_200);
  await shot(app, "connect-sheet");
  await click(page, app.visible("local-sheet-close"));
  await pause(600);

  rec.scene("AgentStudio");
  await click(page, app.testId("nav-inbox"));
  await pause(2_500);
  await rec.stop();
  // Quit outright: the services' hidden windows keep a normal close waiting.
  await app.electron!.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined);
});
