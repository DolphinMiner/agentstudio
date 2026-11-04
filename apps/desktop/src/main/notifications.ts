// System notifications and the Dock badge, on behalf of the renderer.
//
// The renderer decides what to notify (@agentstudio/core NotificationCenter); this
// side shows it, keeps the settings, and routes clicks back. With
// AGENTSTUDIO_TEST_NOTIFICATIONS=1 (e2e) nothing is shown: requests are recorded
// in globalThis.__agentStudioNotifications, where tests read them and click them.

import { Notification, app, shell } from "electron";
import type { AgentNotifyMode, NotificationPrefs, NotifyTarget } from "@agentstudio/core";
import { readBadgeCount, readNotification, readNotificationPrefs, withAgentMode, type DesktopNotification } from "../shared/notifications";
import type { DesktopStorage } from "./storage";

/** A notification request, or the one we show when the switch is first turned on. */
type Shown = Omit<DesktopNotification, "kind"> & { kind: DesktopNotification["kind"] | "hello" };

/** What e2e tests see in test mode. */
export type NotificationTestLog = {
  shown: (Shown & { at: number })[];
  badge: number;
  /** Acts as if the user clicked shown[index]. */
  click(index: number): void;
};

declare global {
  // eslint-disable-next-line no-var
  var __agentStudioNotifications: NotificationTestLog | undefined;
}

/** A click is acted on only this long after it happened (e.g. while signing in). */
const CLICK_TTL_MS = 5 * 60_000;
/** Notifications kept alive for their click handlers (Electron drops handlers of collected ones). */
const KEEP = 50;

export class DesktopNotifier {
  private readonly live = new Set<Notification>();
  private readonly highs = new Set<Notification>();
  /** Low-priority notifications by chat: a newer message replaces the older one. */
  private readonly lowByRoom = new Map<string, Notification>();
  private pendingClick: { target: NotifyTarget; at: number } | null = null;
  private readonly testLog: NotificationTestLog | null;

  constructor(
    private readonly storage: DesktopStorage,
    /** Bring the window forward and tell the renderer a click is waiting. */
    private readonly onClick: () => void,
    testMode = process.env.AGENTSTUDIO_TEST_NOTIFICATIONS === "1",
  ) {
    this.testLog = testMode
      ? {
          shown: [],
          badge: 0,
          click: (i) => {
            const n = this.testLog?.shown[i];
            if (n) this.clicked(n.open);
          },
        }
      : null;
    if (this.testLog) globalThis.__agentStudioNotifications = this.testLog;
  }

  prefs(): NotificationPrefs {
    return readNotificationPrefs(this.storage.readSettings().notifications);
  }

  setEnabled(enabled: boolean): NotificationPrefs {
    const s = this.storage.readSettings();
    const askFirst = enabled && !s.notifications?.askedPermission;
    this.save({ ...this.prefs(), enabled });
    // macOS asks for permission the first time an app shows a notification;
    // turning the switch on is a good moment for that question.
    if (askFirst) this.hello();
    return this.prefs();
  }

  /** The one notification that makes macOS ask for permission. */
  private hello() {
    this.present({
      kind: "hello",
      priority: "normal",
      title: "Notifications are on",
      body: "AgentStudio will let you know when an agent needs you.",
      open: { view: "inbox" },
    });
  }

  setAgentMode(agentId: string, mode: AgentNotifyMode): NotificationPrefs {
    this.save(withAgentMode(this.prefs(), agentId, mode));
    return this.prefs();
  }

  /** A request from the renderer. Malformed requests and requests while switched off are dropped. */
  show(input: unknown) {
    const n = readNotification(input);
    if (!n || !this.prefs().enabled) return;
    this.present(n);
  }

  setBadge(count: unknown) {
    const n = readBadgeCount(count);
    if (this.testLog) this.testLog.badge = n;
    // macOS shows the badge only with notification permission, which it asks
    // for on the first notification. Ask the first time there is a count.
    if (n > 0 && this.prefs().enabled && !this.storage.readSettings().notifications?.askedPermission) this.hello();
    app.setBadgeCount(n);
  }

  /** The click not yet handled by the renderer, if recent; taking it clears it. */
  takeClick(): NotifyTarget | null {
    const c = this.pendingClick;
    this.pendingClick = null;
    return c && Date.now() - c.at < CLICK_TTL_MS ? c.target : null;
  }

  async openSystemSettings() {
    if (process.platform === "darwin") await shell.openExternal("x-apple.systempreferences:com.apple.Notifications-Settings.extension");
  }

  private save(prefs: NotificationPrefs) {
    const s = this.storage.readSettings();
    this.storage.writeSettings({ ...s, notifications: { ...s.notifications, enabled: prefs.enabled, agents: { ...prefs.agents } } });
  }

  private clicked(target: NotifyTarget) {
    this.pendingClick = { target, at: Date.now() };
    this.onClick();
  }

  private present(n: Shown) {
    const s = this.storage.readSettings();
    if (!s.notifications?.askedPermission) this.storage.writeSettings({ ...s, notifications: { ...s.notifications, askedPermission: true } });
    if (this.testLog) {
      this.testLog.shown.push({ ...n, at: Date.now() });
      return;
    }
    if (!Notification.isSupported()) return;
    // Approvals are the porch light: they make a sound and stay until handled
    // where the platform allows it. People's messages are quiet, and a newer
    // message from the same chat replaces the older one.
    const note = new Notification({
      title: n.title,
      body: n.body,
      silent: n.priority === "low",
      ...(n.roomId ? { groupId: n.roomId } : {}),
      ...(n.priority === "high" ? { timeoutType: "never" as const, urgency: "critical" as const } : {}),
      ...(n.priority === "low" ? { urgency: "low" as const } : {}),
    });
    const forget = () => {
      this.live.delete(note);
      this.highs.delete(note);
      if (n.roomId && this.lowByRoom.get(n.roomId) === note) this.lowByRoom.delete(n.roomId);
    };
    note.on("click", () => {
      forget();
      this.clicked(n.open);
    });
    note.on("close", forget);
    note.on("failed", (_e, error) => {
      forget();
      console.warn("[agentstudio] notification failed:", error);
    });
    if (n.priority === "low" && n.roomId) {
      this.lowByRoom.get(n.roomId)?.close();
      this.lowByRoom.set(n.roomId, note);
    }
    this.live.add(note);
    // Cap what we hold on to, but never drop an approval: its click must keep working.
    if (this.live.size > KEEP) {
      for (const old of this.live) {
        if (old === note || this.highs.has(old)) continue;
        this.live.delete(old);
        break;
      }
    }
    if (n.priority === "high") this.highs.add(note);
    note.show();
  }
}
