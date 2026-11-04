// Notification settings and the notification requests the renderer sends to
// the main process: validation shared by main and tests. The rules for when
// to notify live in @agentstudio/core (notifications.ts); types only come from
// there, so the main bundle does not load the core package.

import type { AgentNotifyMode, NotificationPrefs, NotifyKind, NotifyPriority, NotifyTarget } from "@agentstudio/core";

const MODES: readonly AgentNotifyMode[] = ["all", "approvals", "mute"];
const KINDS: readonly NotifyKind[] = ["approval", "agent_message", "agent_problem", "message"];
const PRIORITIES: readonly NotifyPriority[] = ["high", "normal", "low"];
const VIEWS: readonly NotifyTarget["view"][] = ["inbox", "approvals", "connect"];

export function isAgentNotifyMode(v: unknown): v is AgentNotifyMode {
  return MODES.includes(v as AgentNotifyMode);
}

/** Settings as stored in settings.json; missing or bad values fall back to the defaults (on, all). */
export function readNotificationPrefs(raw: unknown): NotificationPrefs {
  const o = raw && typeof raw === "object" ? (raw as { enabled?: unknown; agents?: unknown }) : {};
  const agents: Record<string, AgentNotifyMode> = {};
  if (o.agents && typeof o.agents === "object") {
    for (const [id, mode] of Object.entries(o.agents as Record<string, unknown>)) {
      if (id && isAgentNotifyMode(mode) && mode !== "all") agents[id] = mode;
    }
  }
  return { enabled: o.enabled !== false, agents };
}

/** The same settings with one agent's mode changed ("all" is the default, so it is not stored). */
export function withAgentMode(prefs: NotificationPrefs, agentId: string, mode: AgentNotifyMode): NotificationPrefs {
  const agents = { ...prefs.agents };
  if (mode === "all") delete agents[agentId];
  else agents[agentId] = mode;
  return { ...prefs, agents };
}

/** What the renderer asks the main process to show. */
export type DesktopNotification = {
  kind: NotifyKind;
  priority: NotifyPriority;
  title: string;
  body: string;
  open: NotifyTarget;
  roomId?: string;
};

/** Validates a notification request from the renderer; null when malformed. */
export function readNotification(v: unknown): DesktopNotification | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const open = o.open && typeof o.open === "object" ? (o.open as Record<string, unknown>) : null;
  if (!KINDS.includes(o.kind as NotifyKind) || !PRIORITIES.includes(o.priority as NotifyPriority)) return null;
  if (typeof o.title !== "string" || typeof o.body !== "string" || !o.title.trim()) return null;
  if (!open || !VIEWS.includes(open.view as NotifyTarget["view"])) return null;
  const roomOk = (r: unknown) => typeof r === "string" && r.length > 0 && r.length <= 255;
  const target: NotifyTarget = { view: open.view as NotifyTarget["view"] };
  if (roomOk(open.roomId)) target.roomId = open.roomId as string;
  return {
    kind: o.kind as NotifyKind,
    priority: o.priority as NotifyPriority,
    title: o.title.slice(0, 200),
    body: o.body.slice(0, 500),
    open: target,
    ...(roomOk(o.roomId) ? { roomId: o.roomId as string } : {}),
  };
}

/** A badge count from the renderer: a whole number, capped; anything else is 0. */
export function readBadgeCount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), 9999) : 0;
}
