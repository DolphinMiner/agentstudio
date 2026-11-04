// A signed-in web session for one service, kept in its own persistent Electron
// partition (cookies never mix with the app or other services). The session
// runs in a hidden window; sign-in happens in a visible one. Scripts run in an
// isolated world, so the page's own scripts can't see or tamper with them.

import { BrowserWindow, app, session as electronSession, shell, type WebContents } from "electron";
import { traceNetwork } from "./nettrace";

const WORLD_ID = 1999;

export type WebSessionOptions = {
  /** Partition name, e.g. "persist:agentstudio-muse". */
  partition: string;
  /** Page the hidden session window keeps open. */
  url: string;
  /** Window title for the sign-in window. */
  title: string;
  /** Show the session window instead of hiding it (AGENTSTUDIO_CONNECTOR_SHOW=1). */
  show?: boolean;
  /** File to record the page's API calls in (AGENTSTUDIO_CONNECTOR_TRACE_NETWORK=1). */
  networkTrace?: string;
};

/** A Chrome user agent without the Electron and app tokens, so sites treat us like a browser. */
export function browserUserAgent(): string {
  return app.userAgentFallback.replace(/\s(Electron|AgentStudio|agentstudio)\/\S+/gi, "");
}

export class WebSession {
  private win: BrowserWindow | null = null;
  private loginWin: BrowserWindow | null = null;

  constructor(private readonly opts: WebSessionOptions) {
    const ses = electronSession.fromPartition(opts.partition);
    ses.setUserAgent(browserUserAgent());
    // Pages in these sessions get no device access.
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "clipboard-sanitized-write"));
  }

  get webContents(): WebContents | null {
    return this.win && !this.win.isDestroyed() ? this.win.webContents : null;
  }

  /** Opens (or reuses) the hidden session window on the service URL. */
  async open(): Promise<void> {
    if (this.webContents) return;
    const win = new BrowserWindow({
      show: !!this.opts.show,
      width: 1200,
      height: 900,
      // Not the service's own app: say so, whatever the page calls itself.
      title: `${this.opts.title} · AgentStudio connector`,
      webPreferences: {
        partition: this.opts.partition,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        // The page must render (and lay out) while hidden; DOM checks rely on it.
        offscreen: false,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.on("page-title-updated", (e) => e.preventDefault());
    win.on("close", (e) => {
      // The user closed a shown session window: hide it, the connector still needs it.
      if (!this.closing) {
        e.preventDefault();
        win.hide();
      }
    });
    this.win = win;
    this.broken = null;
    win.webContents.on("render-process-gone", (_e, d) => (this.broken = `page crashed (${d.reason})`));
    win.webContents.on("unresponsive", () => (this.broken = "page stopped responding"));
    win.webContents.on("responsive", () => this.broken === "page stopped responding" && (this.broken = null));
    win.webContents.on("did-fail-load", (_e, code, desc, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.broken = `page didn't load (${desc})`; // -3: aborted by a newer navigation
    });
    win.webContents.on("did-finish-load", () => (this.broken = null));
    if (this.opts.networkTrace) traceNetwork(win.webContents, this.opts.networkTrace, this.opts.title);
    await win.loadURL(this.opts.url).catch(() => {});
  }

  private closing = false;
  /** Why the session page is unusable (crashed, hung, failed to load), or null. */
  broken: string | null = null;

  /** Brings the page back: reload, or a fresh window when the old one is gone. */
  async recover(): Promise<void> {
    const wc = this.webContents;
    if (!wc || wc.isCrashed()) {
      this.win?.destroy();
      this.win = null;
      await this.open();
      return;
    }
    this.broken = null;
    await wc.loadURL(this.opts.url).catch(() => {});
  }

  close() {
    this.closing = true;
    this.loginWin?.destroy();
    this.win?.destroy();
    this.win = null;
    this.loginWin = null;
    this.closing = false;
  }

  /** Shows the session window so the user can act in the service directly. */
  show() {
    if (!this.webContents) void this.open();
    this.win?.show();
    this.win?.focus();
  }

  async reload(url = this.opts.url) {
    await this.webContents?.loadURL(url).catch(() => {});
  }

  /** Downloads an image with this service's cookies (e.g. a persona avatar on its CDN). */
  async fetchImage(url: string): Promise<{ mime: string; data: Buffer } | null> {
    try {
      const res = await electronSession.fromPartition(this.opts.partition).fetch(url, { signal: AbortSignal.timeout(15_000) });
      const mime = res.headers.get("content-type") ?? "";
      if (!res.ok || !mime.startsWith("image/")) return null;
      return { mime, data: Buffer.from(await res.arrayBuffer()) };
    } catch {
      return null;
    }
  }

  /** Runs an expression in the isolated world and returns its (JSON-safe) value. */
  async eval<T>(expression: string, wc: WebContents | null = this.webContents): Promise<T> {
    if (!wc || wc.isDestroyed()) throw new Error("session window is closed");
    return (await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: expression }], true)) as T;
  }

  /** Types into the focused element with real keyboard events (for editors that ignore synthetic input). */
  async pressEnter() {
    const wc = this.webContents;
    if (!wc) return;
    wc.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    wc.sendInputEvent({ type: "char", keyCode: "\r" });
    wc.sendInputEvent({ type: "keyUp", keyCode: "Return" });
  }

  /**
   * Shows a sign-in window on the service and resolves once isSignedIn(page)
   * is true there (checked every second), then reloads the hidden session
   * window, which shares the cookies. Rejects on cancel or window close.
   */
  async signIn(isSignedIn: (wc: WebContents) => Promise<boolean>, signal: AbortSignal): Promise<void> {
    const win = new BrowserWindow({
      width: 980,
      height: 820,
      title: `Sign in: ${this.opts.title}`,
      webPreferences: { partition: this.opts.partition, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    this.loginWin = win;
    // Keep our title, so the user can tell this is AgentStudio's sign-in window.
    win.on("page-title-updated", (e) => e.preventDefault());
    // Sign-in pages may open provider popups (Apple, Google, Meta); keep them in the same partition.
    win.webContents.setWindowOpenHandler(({ url }) =>
      /^https?:\/\//.test(url)
        ? { action: "allow", overrideBrowserWindowOptions: { webPreferences: { partition: this.opts.partition, contextIsolation: true, sandbox: true } } }
        : { action: "deny" },
    );
    await win.loadURL(this.opts.url).catch(() => {});
    try {
      for (;;) {
        if (signal.aborted) throw new Error("cancelled");
        if (win.isDestroyed()) throw new Error("The sign-in window was closed before signing in.");
        if (await isSignedIn(win.webContents).catch(() => false)) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    } finally {
      if (!win.isDestroyed()) win.destroy();
      this.loginWin = null;
    }
    if (this.webContents) await this.reload();
    else await this.open();
  }
}

export function openInBrowser(url: string) {
  void shell.openExternal(url);
}
