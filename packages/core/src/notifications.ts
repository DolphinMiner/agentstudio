// System notifications and the app badge: what to tell the user, and when.
//
// The rules are pure functions (unit tested); NotificationCenter wires them to
// the stores. The client hands each planned notification to the OS and keeps
// the badge in sync; it never re-implements the decisions.
//
// - Only live events that arrive after the first sync count. History that
//   arrives later (bridge backfill, imported messages) is recognised by age.
// - Nothing for the chat (or screen) the user is looking at in a focused window.
// - Per agent: all notifications, approvals only, or mute.
// - Approvals rank above agent replies, which rank above people's messages.

import { isBridgeBot, parseMxid } from "./events.js";
import type { ChatRow } from "./inbox.js";
import { classifyRoom, roomDisplayName, type ChatMessage, type RoomLike } from "./matrix.js";
import type { ReadableStore, Unsubscribe } from "./store.js";
import type { Agent, Approval } from "./types.js";

export type NotifyKind = "approval" | "agent_message" | "agent_problem" | "message";
export type NotifyPriority = "high" | "normal" | "low";

/** Per-agent setting: everything, only approvals, or nothing. */
export type AgentNotifyMode = "all" | "approvals" | "mute";
export const AGENT_NOTIFY_MODES: readonly AgentNotifyMode[] = ["all", "approvals", "mute"];

export type NotificationPrefs = {
  /** The master switch ("System notifications" in Settings). */
  enabled: boolean;
  /** Agent id -> mode; agents not listed get "all". */
  agents: Readonly<Record<string, AgentNotifyMode>>;
};

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = { enabled: true, agents: {} };

/** Where clicking a notification takes the user. `view` is a client screen id. */
export type NotifyTarget = { view: "inbox" | "approvals" | "connect"; roomId?: string };

/** What the user is looking at right now. */
export type Viewing = { focused: boolean; view: string; roomId: string | null };

export type PlannedNotification = {
  kind: NotifyKind;
  priority: NotifyPriority;
  title: string;
  body: string;
  open: NotifyTarget;
  /** The agent it is about, if any. */
  agentId?: string;
  /** The chat it is about; notifications of one chat replace each other when low priority. */
  roomId?: string;
};

/** Events older than this when they reach us are history (backfill, imports, catch-up). */
export const HISTORY_AGE_MS = 2 * 60_000;

const BODY_MAX = 180;

export function agentNotifyMode(prefs: NotificationPrefs, agentId: string | null | undefined): AgentNotifyMode {
  const m = agentId ? prefs.agents[agentId] : undefined;
  return m && AGENT_NOTIFY_MODES.includes(m) ? m : "all";
}

/** Whether an agent's mode lets this kind of notification through. */
export function modeAllows(mode: AgentNotifyMode, kind: NotifyKind): boolean {
  if (mode === "mute") return false;
  if (mode === "approvals") return kind === "approval";
  return true;
}

/** True when the user already sees what the notification points at. */
export function isLookingAt(v: Viewing, target: NotifyTarget): boolean {
  if (!v.focused) return false;
  if (target.view === "inbox") return v.view === "inbox" && !!target.roomId && v.roomId === target.roomId;
  return v.view === target.view;
}

/** One line of text, shortened to the notification body length. */
export function snippet(text: string, max = BODY_MAX): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

/** Notification body: "Sender: text" in groups, just the text in DMs. */
export function notificationBody(senderName: string, body: string, roomName: string): string {
  const text = body.replace(/\s+/g, " ").trim();
  return snippet(senderName && senderName !== roomName ? `${senderName}: ${text}` : text);
}

function messageText(m: Pick<ChatMessage, "body" | "msgtype">): string {
  if (m.body.trim()) return m.body;
  if (m.msgtype === "m.image") return "Sent a photo";
  if (m.msgtype === "m.file" || m.msgtype === "m.video" || m.msgtype === "m.audio") return "Sent a file";
  return "New message";
}

export type IncomingMessage = {
  message: Pick<ChatMessage, "roomId" | "sender" | "senderName" | "own" | "body" | "msgtype" | "approval"> & { history?: boolean };
  /** How old the event was when it reached us. */
  ageMs: number;
  roomName: string;
  isAgentRoom: boolean;
  /** Hidden from the inbox (bridge management rooms, rooms not joined). */
  hidden: boolean;
  /** The bridge bot of our own homeserver sent it (status notices and the like). */
  fromBridgeBot: boolean;
  agent: Pick<Agent, "id" | "name"> | null;
};

/**
 * A notification for a live chat message, or null. Approval cards return null:
 * they are announced as approvals (planApproval) once the approval is loaded.
 */
export function planMessage(input: IncomingMessage, prefs: NotificationPrefs, viewing: Viewing): PlannedNotification | null {
  const m = input.message;
  if (!prefs.enabled || m.own || m.approval || input.hidden || input.fromBridgeBot) return null;
  // Imported history may carry a recent time; the bridge marks it either way.
  if (input.ageMs > HISTORY_AGE_MS || m.history) return null;
  const open: NotifyTarget = { view: "inbox", roomId: m.roomId };
  if (isLookingAt(viewing, open)) return null;
  if (input.isAgentRoom) {
    if (!modeAllows(agentNotifyMode(prefs, input.agent?.id), "agent_message")) return null;
    return {
      kind: "agent_message",
      priority: "normal",
      title: input.agent?.name ?? input.roomName,
      body: snippet(messageText(m)),
      open,
      ...(input.agent ? { agentId: input.agent.id } : {}),
      roomId: m.roomId,
    };
  }
  return {
    kind: "message",
    priority: "low",
    title: input.roomName,
    body: notificationBody(m.senderName, messageText(m), input.roomName),
    open,
    roomId: m.roomId,
  };
}

/** A notification for a new approval request, or null (decided, muted, or on screen). */
export function planApproval(
  a: Approval,
  prefs: NotificationPrefs,
  viewing: Viewing,
  /** The room the card arrived in; the approval's own room_id may not be set yet. */
  cardRoomId?: string,
): PlannedNotification | null {
  if (!prefs.enabled || a.state !== "pending") return null;
  if (!modeAllows(agentNotifyMode(prefs, a.agent_id), "approval")) return null;
  const open: NotifyTarget = { view: "approvals" };
  const roomId = a.room_id ?? cardRoomId;
  if (isLookingAt(viewing, open) || (roomId && isLookingAt(viewing, { view: "inbox", roomId }))) return null;
  return {
    kind: "approval",
    priority: "high",
    title: snippet(a.title, 120),
    body: a.agent_name,
    open,
    agentId: a.agent_id,
    ...(roomId ? { roomId } : {}),
  };
}

// ---- agent problems ------------------------------------------------------------

export type AgentHealth = "ok" | "needs_login" | "error";

/** The status of a connector that runs on this device (desktop), by agents-bridge connection. */
export type ConnectorHealth = {
  connectionId?: string;
  status: "ready" | "needs_login" | "starting" | "reconnecting" | "error";
  message?: string;
};

/**
 * An agent's health: from its local connector when it has one, else from the
 * agent's own status (offline counts as a problem). Null while unknown
 * (connector starting, or the connector list not loaded yet).
 */
export function agentHealth(
  agent: Pick<Agent, "connection_id" | "status">,
  connectors: readonly ConnectorHealth[] | null,
): { health: AgentHealth; message?: string } | null {
  if (connectors === null) return null;
  const c = connectors.find((x) => x.connectionId === agent.connection_id);
  if (c) {
    // Starting, or reloading its page after a dropped connection: wait and see, don't alarm.
    if (c.status === "starting" || c.status === "reconnecting") return null;
    if (c.status === "ready") return { health: "ok" };
    return { health: c.status, ...(c.message ? { message: c.message } : {}) };
  }
  return { health: agent.status === "offline" ? "error" : "ok" };
}

export function planAgentProblem(
  agent: Pick<Agent, "id" | "name">,
  problem: { health: Exclude<AgentHealth, "ok">; message?: string },
  prefs: NotificationPrefs,
  viewing: Viewing,
): PlannedNotification | null {
  if (!prefs.enabled || !modeAllows(agentNotifyMode(prefs, agent.id), "agent_problem")) return null;
  const open: NotifyTarget = { view: "connect" };
  if (isLookingAt(viewing, open)) return null;
  const body =
    problem.health === "needs_login"
      ? `Sign in again so ${agent.name} can keep working.`
      : problem.message
        ? snippet(problem.message)
        : `${agent.name} isn't responding.`;
  return { kind: "agent_problem", priority: "normal", title: agent.name, body, open, agentId: agent.id };
}

// ---- badge -----------------------------------------------------------------------

/** The app badge: pending approvals plus unread messages in agent chats (as the inbox shows them). */
export function badgeCount(pendingApprovals: number, rows: readonly Pick<ChatRow, "isAgent" | "unread">[]): number {
  let n = pendingApprovals;
  for (const r of rows) if (r.isAgent) n += r.unread;
  return n;
}

// ---- wiring ----------------------------------------------------------------------

/** A live message from someone else that arrived after the first sync. */
export type LiveMessage = { message: ChatMessage; room: RoomLike; ageMs: number };
export type LiveMessageListener = (m: LiveMessage) => void;

export interface NotificationCenterOptions {
  matrix: { readonly userId: string; onLiveMessage(l: LiveMessageListener): Unsubscribe };
  approvals: { load(id: string): Promise<Approval>; subscribe(l: () => void): Unsubscribe; readonly pendingCount: number };
  agents: { subscribe(l: () => void): Unsubscribe; getSnapshot(): { items: Agent[]; loading: boolean } };
  inbox: { readonly rows: ReadableStore<ChatRow[]> };
  /** Connectors running on this device (desktop); null until first loaded. Omit elsewhere. */
  connectors?: ReadableStore<readonly ConnectorHealth[] | null>;
  prefs(): NotificationPrefs;
  viewing(): Viewing;
  /** Show a notification (the client hands it to the OS). */
  deliver(n: PlannedNotification): void;
  /** Set the app badge; 0 clears it. Called only when the count changes. */
  setBadge(count: number): void;
}

/**
 * Turns store changes into notifications and badge updates. Create it once per
 * signed-in session, after the stores; call dispose() on sign-out (it clears
 * the badge).
 */
export class NotificationCenter {
  private readonly unsubs: Unsubscribe[] = [];
  private readonly announced = new Set<string>(); // approval ids
  private readonly health = new Map<string, AgentHealth>();
  private badge = -1;
  private disposed = false;

  constructor(private readonly o: NotificationCenterOptions) {
    this.unsubs.push(o.matrix.onLiveMessage((m) => this.onMessage(m)));
    this.unsubs.push(o.approvals.subscribe(() => this.updateBadge()));
    this.unsubs.push(o.inbox.rows.subscribe(() => this.updateBadge()));
    this.unsubs.push(o.agents.subscribe(() => this.checkAgents()));
    if (o.connectors) this.unsubs.push(o.connectors.subscribe(() => this.checkAgents()));
    this.updateBadge();
    this.checkAgents();
  }

  dispose(): void {
    this.disposed = true;
    for (const u of this.unsubs.splice(0)) u();
    if (this.badge !== 0) this.o.setBadge(0);
    this.badge = 0;
  }

  private deliver(n: PlannedNotification | null) {
    if (n && !this.disposed) this.o.deliver(n);
  }

  private onMessage({ message, room, ageMs }: LiveMessage) {
    const me = this.o.matrix.userId;
    const cls = classifyRoom(room, me);
    const agent = cls.isAgentRoom ? (this.o.agents.getSnapshot().items.find((a) => a.room_id === room.roomId) ?? null) : null;
    if (message.approval && !message.own && !cls.hidden && ageMs <= HISTORY_AGE_MS) {
      this.announceApproval(message.approval.approval_id, room.roomId);
      return;
    }
    this.deliver(
      planMessage(
        {
          message,
          ageMs,
          roomName: agent?.name ?? roomDisplayName(room, me),
          isAgentRoom: cls.isAgentRoom,
          hidden: cls.hidden,
          fromBridgeBot: isBridgeBot(message.sender, parseMxid(me)?.server ?? ""),
          agent,
        },
        this.o.prefs(),
        this.o.viewing(),
      ),
    );
  }

  private announceApproval(id: string, roomId: string) {
    if (this.announced.has(id)) return;
    this.announced.add(id);
    this.o.approvals.load(id).then(
      (a) => this.deliver(planApproval(a, this.o.prefs(), this.o.viewing(), roomId)),
      () => this.announced.delete(id),
    );
  }

  private updateBadge() {
    if (this.disposed) return;
    const n = badgeCount(this.o.approvals.pendingCount, this.o.inbox.rows.getSnapshot());
    if (n === this.badge) return;
    this.badge = n;
    this.o.setBadge(n);
  }

  /** Notify when an agent goes from healthy (or another problem) to needing the user. */
  private checkAgents() {
    const snap = this.o.agents.getSnapshot();
    if (snap.loading) return;
    const connectors = this.o.connectors ? this.o.connectors.getSnapshot() : [];
    for (const agent of snap.items) {
      const h = agentHealth(agent, connectors);
      if (!h) continue;
      const prev = this.health.get(agent.id);
      this.health.set(agent.id, h.health);
      // The first time we see an agent is the baseline: no notification at startup.
      if (prev === undefined || prev === h.health || h.health === "ok") continue;
      this.deliver(planAgentProblem(agent, { health: h.health, ...(h.message ? { message: h.message } : {}) }, this.o.prefs(), this.o.viewing()));
    }
  }
}
