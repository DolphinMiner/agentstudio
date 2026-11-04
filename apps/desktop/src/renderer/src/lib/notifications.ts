// Notification settings in the renderer (saved by the main process), and the
// NotificationCenter that turns store changes into notifications and the badge.

import {
  DEFAULT_NOTIFICATION_PREFS,
  NotificationCenter,
  Store,
  type AgentNotifyMode,
  type NotificationPrefs,
  type Viewing,
} from "@agentstudio/core";
import { desktop } from "./desktop";
import { localConnectors } from "./marks";
import type { Runtime } from "./runtime";

export const notificationPrefs = new Store<NotificationPrefs>(DEFAULT_NOTIFICATION_PREFS);

export async function loadNotificationPrefs(): Promise<void> {
  notificationPrefs.set(await desktop.notifications.prefs());
}

export async function setNotificationsEnabled(enabled: boolean): Promise<void> {
  notificationPrefs.set(await desktop.notifications.setEnabled(enabled));
}

export async function setAgentNotifyMode(agentId: string, mode: AgentNotifyMode): Promise<void> {
  notificationPrefs.set(await desktop.notifications.setAgentMode(agentId, mode));
}

export const AGENT_MODE_LABELS: Record<AgentNotifyMode, string> = {
  all: "All notifications",
  approvals: "Approvals only",
  mute: "Mute",
};

/** Starts notifications for a signed-in workspace; returns a stop function (which clears the badge). */
export function startNotifications(rt: Runtime, viewing: () => Omit<Viewing, "focused">): () => void {
  void loadNotificationPrefs().catch(() => undefined);
  const center = new NotificationCenter({
    matrix: rt.matrix,
    approvals: rt.approvals,
    agents: rt.agents,
    inbox: rt.inbox,
    connectors: localConnectors,
    prefs: () => notificationPrefs.getSnapshot(),
    viewing: () => ({ ...viewing(), focused: document.visibilityState === "visible" && document.hasFocus() }),
    deliver: (n) => desktop.notifications.show({ kind: n.kind, priority: n.priority, title: n.title, body: n.body, open: n.open, ...(n.roomId ? { roomId: n.roomId } : {}) }),
    setBadge: (count) => desktop.notifications.setBadge(count),
  });
  return () => center.dispose();
}
