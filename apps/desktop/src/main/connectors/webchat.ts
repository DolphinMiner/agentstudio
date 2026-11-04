// A connector for agents the user talks to in a web chat (Muse, ChatGPT Dots).
// It drives the service's own page in a hidden, signed-in window through a page
// driver (drivers.ts): sending types into the page's composer, and replies are
// read from the page as they finish. Nothing here calls the service's private
// APIs directly; the page does, with the user's session (they can't be called
// directly: see docs/spikes/muse-dots-direct-api.md).
//
// The window never shows itself. When the page loses its connection, crashes or
// stops loading, the connector reloads it (with backoff) and tells the user the
// agent is reconnecting.

import { askPrompt, parseDrafts, truncate, HISTORY_ON_CONNECT, MAX_TEXT, type AgentInfo, type InboundMessage } from "./protocol";
import { OPEN, buttonChoices } from "./choices";
import { createHash } from "node:crypto";
import { shell } from "electron";
import { UnknownApprovalError, type AvatarImage, type Connector, type ConnectorState, type Emitter, type Trace } from "./types";
import { WebSession } from "./websession";
import { recoveryStep } from "./recovery";
import type { WebContents } from "electron";

export type WebChatConfig = {
  name: string;
  description: string;
  partition: string;
  url: string;
  driver: string;
  pollMs: number;
  show?: boolean;
  trace?: Trace;
  /** File for the page's API calls (calibration). */
  networkTrace?: string;
  /** Shown when an agent message needs the user but has no buttons we understand. */
  openLabel: string;
  /** The service's official image, until the page shows the persona's own avatar. */
  fallbackAvatar: () => Promise<AvatarImage | null>;
};

export type WebChatData = { connectedAt: string; historyImported?: boolean };

type PageMessage = { id: string; role: "user" | "assistant"; text: string; widget?: boolean; actions: string[] };
type Snapshot = { signedIn: boolean; ready: boolean; busy: boolean; messages: PageMessage[]; problem?: string | null };

export async function installDriver(session: WebSession, driver: string, wc?: WebContents | null): Promise<void> {
  const has = await session.eval<boolean>("typeof globalThis.__agentstudio === 'object'", wc).catch(() => false);
  if (!has) await session.eval(driver, wc);
}

export async function snapshotOf(session: WebSession, driver: string, wc?: WebContents | null): Promise<Snapshot> {
  await installDriver(session, driver, wc);
  return session.eval<Snapshot>("globalThis.__agentstudio.snapshot()", wc);
}

export class WebChatConnector implements Connector {
  /** Texts AgentStudio sent, so the page's copy isn't shown as typed in the service. */
  private ownTexts = new Set<string>();
  readonly session: WebSession;
  private emitter: Emitter | null = null;
  private status: ConnectorState = { status: "starting" };
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private seen = new Set<string>();
  private pending = new Map<string, { text: string; polls: number }>();
  private approvals = new Map<string, { messageId: string; labels: Map<string, string> }>();
  private pendingAsk: string | null = null;
  private workingSince = 0;
  private baselined = false;
  private avatarImg: AvatarImage | null = null;
  private profileCheckedAt = 0;
  /** History is loaded lazily; baseline once the page shows the same messages twice. */
  private baselineProbe: { ids: string; since: number } | null = null;
  // Recovery from a lost connection (see recoveryStep).
  private problemSince: number | null = null;
  private tickErrors = 0;
  private attempts = 0;
  private lastAttemptAt = 0;
  /** After a reload: the last message seen before it, so replies that came during the outage still count. */
  private resumeAfter: string | null = null;

  constructor(
    private readonly cfg: WebChatConfig,
    private readonly data: WebChatData,
    session?: WebSession,
  ) {
    this.session = session ?? new WebSession({ partition: cfg.partition, url: cfg.url, title: cfg.name, show: cfg.show, networkTrace: cfg.networkTrace });
  }

  info(): AgentInfo {
    return { name: this.cfg.name, description: this.cfg.description, capabilities: ["chat", "ask", "approvals"], protocol: "agentstudio-agent/0" };
  }

  state(): ConnectorState {
    return this.status;
  }

  serialize(): unknown {
    return this.data;
  }

  /** "View in Muse": the service in the user's browser. The session window itself never shows. */
  open() {
    void shell.openExternal(this.cfg.url);
  }

  async start(emitter: Emitter): Promise<void> {
    this.emitter = emitter;
    this.running = true;
    await this.session.open();
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.session.close();
  }

  async send(msg: InboundMessage): Promise<void> {
    // Wait until the page's history has loaded, so it isn't mistaken for replies.
    for (let i = 0; !this.baselined && i < 40; i++) await new Promise((r) => setTimeout(r, 250));
    // Reconnecting: give the page up to 45 s to come back before giving up on this message.
    for (let i = 0; this.status.status === "reconnecting" && i < 90; i++) await new Promise((r) => setTimeout(r, 500));
    if (this.status.status === "reconnecting") throw new Error(`${this.cfg.name} is reconnecting. Try again in a minute.`);
    const snap = await this.snapshot();
    if (!snap.signedIn) {
      this.status = { status: "needs_login", message: `Sign in to ${this.cfg.name} again.` };
      throw new Error(`${this.cfg.name} is signed out. Open it from AgentStudio's Connect screen and sign in again.`);
    }
    // Anything already on the page is history, not a reply to this message
    // (except a reply still streaming in, which we keep waiting for).
    for (const m of snap.messages) if (!this.pending.has(m.id)) this.seen.add(m.id);
    const text = msg.ask ? askPrompt(msg.ask) : msg.text;
    this.ownTexts.add(text.trim());
    const res = await this.session.eval<{ ok: boolean; error?: string; pressEnter?: boolean }>(
      `globalThis.__agentstudio.submit(${JSON.stringify(text)})`,
    );
    if (!res.ok) throw new Error(res.error ?? `Couldn't send to ${this.cfg.name}`);
    if (res.pressEnter) await this.session.pressEnter();
    this.cfg.trace?.("webchat.sent", { agent: this.cfg.name, ask: !!msg.ask });
    if (msg.ask) this.pendingAsk = msg.ask.task_id;
    this.workingSince = Date.now();
    this.emitter?.emit({ type: "status", state: "working", text: "Working" });
    this.schedule(this.cfg.pollMs);
  }

  async decide(externalId: string, choice: string): Promise<void> {
    const a = this.approvals.get(externalId);
    if (!a) throw new UnknownApprovalError();
    this.approvals.delete(externalId);
    if (choice === OPEN) {
      this.open();
      return;
    }
    const label = a.labels.get(choice);
    if (!label) return; // "Dismiss" and friends: nothing to do on the page
    const res = await this.session.eval<{ ok: boolean; error?: string }>(
      `globalThis.__agentstudio.click(${JSON.stringify(a.messageId)}, ${JSON.stringify(label)})`,
    );
    if (!res.ok) throw new Error(res.error ?? "Couldn't answer on the page");
    this.workingSince = Date.now();
    this.schedule(this.cfg.pollMs);
  }

  async avatar(): Promise<AvatarImage | null> {
    return this.avatarImg ?? (await this.cfg.fallbackAvatar());
  }

  /** Reads the persona's avatar from the page (every few minutes) and reports changes. */
  private async refreshProfile() {
    if (Date.now() - this.profileCheckedAt < 5 * 60_000) return;
    this.profileCheckedAt = Date.now();
    const p = await this.session
      .eval<{ name: string | null; avatar: { src?: string; frame?: string } | null }>("globalThis.__agentstudio.profile ? globalThis.__agentstudio.profile() : null")
      .catch(() => null);
    if (!p?.avatar) return;
    let img: AvatarImage | null = null;
    if (p.avatar.frame?.startsWith("data:image/png;base64,")) {
      img = { mime: "image/png", data: Buffer.from(p.avatar.frame.split(",")[1]!, "base64") };
    } else if (p.avatar.src && /^https:\/\//.test(p.avatar.src)) {
      img = await this.session.fetchImage(p.avatar.src);
    }
    if (!img || img.data.length > 2 << 20) return;
    const same = this.avatarImg && createHash("sha256").update(this.avatarImg.data).digest("hex") === createHash("sha256").update(img.data).digest("hex");
    if (same) return;
    this.avatarImg = img;
    this.cfg.trace?.("webchat.avatar", { agent: this.cfg.name, bytes: img.data.length });
    this.emitter?.profileChanged();
  }

  private snapshot(): Promise<Snapshot> {
    return snapshotOf(this.session, this.cfg.driver);
  }

  private schedule(ms: number) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick() {
    if (!this.running) return;
    let snap: Snapshot | null = null;
    try {
      snap = await this.snapshot();
      this.tickErrors = 0;
    } catch (err) {
      // The page is navigating or still loading; a few in a row mean it's stuck.
      this.tickErrors++;
      this.cfg.trace?.("webchat.tick_error", { agent: this.cfg.name, message: String((err as Error).message) });
    }
    if (snap?.problem) this.problemSince ??= Date.now();
    else if (snap) this.problemSince = null;
    if (await this.recoverIfNeeded()) {
      this.schedule(this.cfg.pollMs * 2);
      return;
    }
    try {
      if (!snap) throw new Error("no snapshot");
      if (!snap.signedIn) {
        this.status = { status: "needs_login", message: `Sign in to ${this.cfg.name} again.` };
      } else {
        this.status = { status: "ready" };
        void this.refreshProfile();
        if (!this.baselined) {
          // Treat everything already there as history. The page fills its log
          // in bursts after load, so wait until it stops changing for 2 s.
          const ids = snap.messages.map((m) => m.id).join(",");
          if (!this.baselineProbe || this.baselineProbe.ids !== ids) this.baselineProbe = { ids, since: Date.now() };
          // After a reload, messages after the last one seen before it arrived during the outage: keep them.
          const cut = this.resumeAfter ? snap.messages.findIndex((m) => m.id === this.resumeAfter) : -1;
          for (const [i, m] of snap.messages.entries()) if (cut < 0 || i <= cut) this.seen.add(m.id);
          if (snap.ready && Date.now() - this.baselineProbe.since >= 2000) {
            this.baselined = true;
            this.resumeAfter = null;
            // On the first connect the last few messages come over as history.
            if (!this.data.historyImported) {
              this.data.historyImported = true;
              for (const m of snap.messages.filter((x) => x.text).slice(-HISTORY_ON_CONNECT)) {
                this.emitter?.emit({ type: "message", text: truncate(m.text, MAX_TEXT), history: true, ...(m.role === "user" ? { from_user: true, via: this.cfg.name } : {}) });
              }
            }
            this.process(snap);
          }
        } else {
          this.process(snap);
        }
      }
    } catch {
      // Counted above; try again.
    }
    const active = Date.now() - this.workingSince < 10 * 60_000;
    this.schedule(active ? this.cfg.pollMs : this.cfg.pollMs * 4);
  }

  /**
   * Reloads the page when it has been broken for a while (see recoveryStep),
   * and reports "reconnecting" until it works again. True while recovering.
   */
  private async recoverIfNeeded(): Promise<boolean> {
    const step = recoveryStep(
      { problemSince: this.problemSince, tickErrors: this.tickErrors, broken: this.session.broken, attempts: this.attempts, lastAttemptAt: this.lastAttemptAt },
      Date.now(),
    );
    if (step === "ok") {
      if (this.attempts > 0) {
        this.attempts = 0;
        this.cfg.trace?.("webchat.recovered", { agent: this.cfg.name });
        this.emitter?.emit({ type: "status", state: "idle" });
      }
      return false;
    }
    if (step === "wait") return this.attempts > 0 && this.status.status === "reconnecting";
    const reason = this.session.broken ?? (this.problemSince !== null ? "the page lost its connection" : "the page stopped answering");
    if (this.attempts === 0) this.emitter?.emit({ type: "status", state: "idle", text: "Reconnecting…" });
    this.status = { status: "reconnecting", message: `Reconnecting to ${this.cfg.name}: ${reason}` };
    this.attempts++;
    this.lastAttemptAt = Date.now();
    this.cfg.trace?.("webchat.reconnect", { agent: this.cfg.name, attempt: this.attempts, reason });
    // Remember where the conversation was, then start the page over.
    this.resumeAfter = [...this.seen].pop() ?? null;
    this.baselined = false;
    this.baselineProbe = null;
    this.problemSince = null;
    this.tickErrors = 0;
    await this.session.recover();
    return true;
  }

  private process(snap: Snapshot) {
    const emit = (e: Parameters<Emitter["emit"]>[0]) => this.emitter?.emit(e);
    for (const m of snap.messages) {
      if (this.seen.has(m.id)) continue;
      if (m.role === "user") {
        this.seen.add(m.id);
        // Typed in the service itself (AgentStudio's own sends are skipped).
        if (m.text && !this.ownTexts.delete(m.text.trim())) emit({ type: "message", text: truncate(m.text, MAX_TEXT), from_user: true, via: this.cfg.name });
        continue;
      }
      // Replies stream in: emit once the text is stable and the agent is idle.
      const p = this.pending.get(m.id);
      const stable = !!p && p.text === m.text && !snap.busy;
      if (!stable && (p?.polls ?? 0) < 120) {
        this.pending.set(m.id, { text: m.text, polls: (p?.polls ?? 0) + 1 });
        continue;
      }
      this.pending.delete(m.id);
      this.seen.add(m.id);
      this.cfg.trace?.("webchat.reply", { agent: this.cfg.name, chars: m.text.length, actions: m.actions, widget: !!m.widget });
      if (m.text) {
        if (this.pendingAsk) {
          const taskId = this.pendingAsk;
          this.pendingAsk = null;
          emit({ type: "drafts", task_id: taskId, drafts: parseDrafts(m.text).map((text) => ({ text })) });
        } else {
          emit({ type: "message", text: truncate(m.text, MAX_TEXT) });
        }
      }
      const choices = buttonChoices(m.actions);
      if (choices) {
        const id = `${m.id}`.slice(0, 180);
        this.approvals.set(id, { messageId: m.id, labels: new Map(choices.map((c) => [c.key, c.label])) });
        emit({ type: "approval_request", external_id: id, title: truncate(m.text.split("\n")[0] || `${this.cfg.name} needs your decision`, 300), choices });
      } else if (m.widget && !m.text) {
        // An interactive card (checklist, picker, ...) AgentStudio can't show yet.
        emit({ type: "message", text: `${this.cfg.name} sent an interactive card AgentStudio can't show yet. View it in ${this.cfg.name}: ${this.cfg.url}` });
      }
      if (!snap.busy) emit({ type: "status", state: "idle" });
    }
  }
}
