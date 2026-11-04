import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFS,
  HISTORY_AGE_MS,
  NotificationCenter,
  agentHealth,
  agentNotifyMode,
  badgeCount,
  isLookingAt,
  modeAllows,
  notificationBody,
  planAgentProblem,
  planApproval,
  planMessage,
  type ConnectorHealth,
  type IncomingMessage,
  type LiveMessageListener,
  type NotificationPrefs,
  type PlannedNotification,
  type Viewing,
} from "../src/notifications.js";
import { toChatMessage } from "../src/matrix.js";
import { Store } from "../src/store.js";
import type { ChatRow } from "../src/inbox.js";
import type { Agent, Approval } from "../src/types.js";
import { ME, agent, approval, ev, room, sleep } from "./fakes.js";

const away: Viewing = { focused: false, view: "inbox", roomId: "!agent:agentstudio.local" };
const on = DEFAULT_NOTIFICATION_PREFS;
const prefs = (agents: NotificationPrefs["agents"], enabled = true): NotificationPrefs => ({ enabled, agents });

function incoming(over: Partial<IncomingMessage> & { body?: string; own?: boolean; approval?: boolean; history?: boolean } = {}): IncomingMessage {
  const { body = "Found a 6pm flight", own = false, approval: card = false, history = false, ...rest } = over;
  return {
    message: {
      roomId: "!agent:agentstudio.local",
      sender: "@agents_concierge:agentstudio.local",
      senderName: "Concierge",
      own,
      body,
      msgtype: "m.text",
      approval: card ? { v: 1, approval_id: "apr_1" } : null,
      history,
    },
    ageMs: 500,
    roomName: "Concierge",
    isAgentRoom: true,
    hidden: false,
    fromBridgeBot: false,
    agent: { id: "agentstudio-agents:concierge", name: "Concierge" },
    ...rest,
  };
}

describe("agent modes", () => {
  it("defaults to all and ignores unknown values", () => {
    expect(agentNotifyMode(on, "x")).toBe("all");
    expect(agentNotifyMode(prefs({ x: "mute" }), "x")).toBe("mute");
    expect(agentNotifyMode(prefs({ x: "loud" as never }), "x")).toBe("all");
    expect(agentNotifyMode(prefs({ x: "mute" }), null)).toBe("all");
  });
  it("lets approvals through in approvals-only mode, nothing when muted", () => {
    for (const k of ["approval", "agent_message", "agent_problem", "message"] as const) expect(modeAllows("all", k)).toBe(true);
    expect(modeAllows("approvals", "approval")).toBe(true);
    expect(modeAllows("approvals", "agent_message")).toBe(false);
    expect(modeAllows("approvals", "agent_problem")).toBe(false);
    for (const k of ["approval", "agent_message", "agent_problem"] as const) expect(modeAllows("mute", k)).toBe(false);
  });
});

describe("isLookingAt", () => {
  it("needs focus and the same chat or screen", () => {
    const chat = { view: "inbox" as const, roomId: "!r" };
    expect(isLookingAt({ focused: true, view: "inbox", roomId: "!r" }, chat)).toBe(true);
    expect(isLookingAt({ focused: false, view: "inbox", roomId: "!r" }, chat)).toBe(false);
    expect(isLookingAt({ focused: true, view: "inbox", roomId: "!other" }, chat)).toBe(false);
    expect(isLookingAt({ focused: true, view: "tasks", roomId: "!r" }, chat)).toBe(false);
    expect(isLookingAt({ focused: true, view: "approvals", roomId: null }, { view: "approvals" })).toBe(true);
  });
});

describe("planMessage", () => {
  it("announces an agent reply with the agent's name and the start of the message", () => {
    const n = planMessage(incoming({ body: "Found a 6pm\nflight " + "x".repeat(300) }), on, away);
    expect(n).toMatchObject({ kind: "agent_message", priority: "normal", title: "Concierge", agentId: "agentstudio-agents:concierge", open: { view: "inbox", roomId: "!agent:agentstudio.local" } });
    expect(n!.body.startsWith("Found a 6pm flight x")).toBe(true);
    expect(n!.body.length).toBeLessThanOrEqual(180);
  });

  it("skips own messages, history, hidden rooms, bridge bots and approval cards", () => {
    expect(planMessage(incoming({ own: true }), on, away)).toBeNull();
    expect(planMessage(incoming({ ageMs: HISTORY_AGE_MS + 1 }), on, away)).toBeNull();
    // Imported history is marked by the bridge, whatever its time.
    expect(planMessage(incoming({ history: true }), on, away)).toBeNull();
    expect(planMessage(incoming({ hidden: true }), on, away)).toBeNull();
    expect(planMessage(incoming({ fromBridgeBot: true }), on, away)).toBeNull();
    expect(planMessage(incoming({ approval: true }), on, away)).toBeNull();
  });

  it("skips the chat the user is looking at, but not other chats", () => {
    expect(planMessage(incoming(), on, { focused: true, view: "inbox", roomId: "!agent:agentstudio.local" })).toBeNull();
    expect(planMessage(incoming(), on, { focused: true, view: "inbox", roomId: "!leo" })).not.toBeNull();
    expect(planMessage(incoming(), on, { focused: false, view: "inbox", roomId: "!agent:agentstudio.local" })).not.toBeNull();
  });

  it("follows the master switch and the agent's mode", () => {
    expect(planMessage(incoming(), prefs({}, false), away)).toBeNull();
    expect(planMessage(incoming(), prefs({ "agentstudio-agents:concierge": "approvals" }), away)).toBeNull();
    expect(planMessage(incoming(), prefs({ "agentstudio-agents:concierge": "mute" }), away)).toBeNull();
    expect(planMessage(incoming(), prefs({ other: "mute" }), away)).not.toBeNull();
  });

  it("announces people's messages at low priority", () => {
    const leo = incoming({ isAgentRoom: false, agent: null, roomName: "Leo Park" });
    leo.message = { ...leo.message, roomId: "!leo", senderName: "Leo Park", body: "Are we still on?" };
    expect(planMessage(leo, on, away)).toEqual({
      kind: "message",
      priority: "low",
      title: "Leo Park",
      body: "Are we still on?",
      open: { view: "inbox", roomId: "!leo" },
      roomId: "!leo",
    });
    expect(planMessage(leo, prefs({}, false), away)).toBeNull();
  });

  it("describes messages without text", () => {
    const img = incoming();
    img.message = { ...img.message, body: "", msgtype: "m.image" };
    expect(planMessage(img, on, away)!.body).toBe("Sent a photo");
  });

  it("prefixes the sender in groups only", () => {
    expect(notificationBody("Mia", "Chapter 4?", "Book Club")).toBe("Mia: Chapter 4?");
    expect(notificationBody("Leo", "hi\nthere", "Leo")).toBe("hi there");
    expect(notificationBody("A", "x".repeat(300), "B").length).toBe(180);
  });
});

describe("planApproval", () => {
  it("uses the approval title and the agent name, and opens Approvals", () => {
    expect(planApproval(approval(), on, away)).toEqual({
      kind: "approval",
      priority: "high",
      title: "Book the 6pm flight to Toronto for $412?",
      body: "Concierge",
      open: { view: "approvals" },
      agentId: "agentstudio-agents:concierge",
      roomId: "!agent:agentstudio.local",
    });
  });

  it("ranks above agent replies, which rank above people", () => {
    const rank = (n: PlannedNotification | null) => ["low", "normal", "high"].indexOf(n!.priority);
    const leo = incoming({ isAgentRoom: false, agent: null });
    expect(rank(planApproval(approval(), on, away))).toBeGreaterThan(rank(planMessage(incoming(), on, away)));
    expect(rank(planMessage(incoming(), on, away))).toBeGreaterThan(rank(planMessage(leo, on, away)));
  });

  it("uses the card's room while the approval has none yet", () => {
    const early = approval({ room_id: null });
    expect(planApproval(early, on, away, "!agent:agentstudio.local")?.roomId).toBe("!agent:agentstudio.local");
    expect(planApproval(early, on, { focused: true, view: "inbox", roomId: "!agent:agentstudio.local" }, "!agent:agentstudio.local")).toBeNull();
  });

  it("skips decided approvals, muted agents and approvals already on screen", () => {
    expect(planApproval(approval({ state: "decided" }), on, away)).toBeNull();
    expect(planApproval(approval(), prefs({ "agentstudio-agents:concierge": "mute" }), away)).toBeNull();
    expect(planApproval(approval(), prefs({ "agentstudio-agents:concierge": "approvals" }), away)).not.toBeNull();
    expect(planApproval(approval(), prefs({}, false), away)).toBeNull();
    expect(planApproval(approval(), on, { focused: true, view: "approvals", roomId: null })).toBeNull();
    expect(planApproval(approval(), on, { focused: true, view: "inbox", roomId: "!agent:agentstudio.local" })).toBeNull();
    expect(planApproval(approval(), on, { focused: true, view: "tasks", roomId: "!agent:agentstudio.local" })).not.toBeNull();
  });
});

describe("agent problems", () => {
  const grok = agent({ id: "agentstudio-agents:grok", connection_id: "agentstudio-agents:grok", name: "Grok Bot" });
  it("reads local connectors first, then the agent status", () => {
    const c = (status: ConnectorHealth["status"], message?: string): ConnectorHealth[] => [{ connectionId: "agentstudio-agents:grok", status, ...(message ? { message } : {}) }];
    expect(agentHealth(grok, null)).toBeNull();
    expect(agentHealth(grok, c("starting"))).toBeNull();
    expect(agentHealth(grok, c("reconnecting"))).toBeNull(); // a page reload, not a problem to report
    expect(agentHealth(grok, c("ready"))).toEqual({ health: "ok" });
    expect(agentHealth(grok, c("needs_login"))).toEqual({ health: "needs_login" });
    expect(agentHealth(grok, c("error", "HTTP 500"))).toEqual({ health: "error", message: "HTTP 500" });
    expect(agentHealth(grok, [])).toEqual({ health: "ok" });
    expect(agentHealth({ ...grok, status: "offline" }, [])).toEqual({ health: "error" });
  });
  it("asks the user to sign in again, and opens Connect", () => {
    expect(planAgentProblem(grok, { health: "needs_login" }, on, away)).toMatchObject({
      kind: "agent_problem",
      title: "Grok Bot",
      body: "Sign in again so Grok Bot can keep working.",
      open: { view: "connect" },
    });
    expect(planAgentProblem(grok, { health: "error" }, on, away)!.body).toBe("Grok Bot isn't responding.");
    expect(planAgentProblem(grok, { health: "error" }, prefs({ [grok.id]: "approvals" }), away)).toBeNull();
    expect(planAgentProblem(grok, { health: "error" }, on, { focused: true, view: "connect", roomId: null })).toBeNull();
  });
});

it("badge = pending approvals + unread messages in agent chats", () => {
  expect(badgeCount(0, [])).toBe(0);
  expect(badgeCount(2, [{ isAgent: true, unread: 3 }, { isAgent: false, unread: 5 }, { isAgent: true, unread: 1 }])).toBe(6);
});

// ---- NotificationCenter with fake stores ---------------------------------------

function center(opts: { prefs?: NotificationPrefs; viewing?: Viewing; connectors?: Store<ConnectorHealth[] | null> } = {}) {
  let live: LiveMessageListener = () => {};
  const approvalsState = new Store({ count: 0 });
  const cards: Record<string, Approval> = { apr_1: approval() };
  const approvals = {
    load: vi.fn(async (id: string) => {
      const a = cards[id];
      if (!a) throw new Error("not found");
      return a;
    }),
    subscribe: approvalsState.subscribe,
    get pendingCount() {
      return approvalsState.getSnapshot().count;
    },
  };
  const agents = new Store<{ items: Agent[]; loading: boolean }>({ items: [agent()], loading: false });
  const rows = new Store<ChatRow[]>([]);
  const delivered: PlannedNotification[] = [];
  const badges: number[] = [];
  let p = opts.prefs ?? on;
  const c = new NotificationCenter({
    matrix: {
      userId: ME,
      onLiveMessage: (l) => {
        live = l;
        return () => (live = () => {});
      },
    },
    approvals,
    agents,
    inbox: { rows },
    ...(opts.connectors ? { connectors: opts.connectors } : {}),
    prefs: () => p,
    viewing: () => opts.viewing ?? away,
    deliver: (n) => delivered.push(n),
    setBadge: (n) => badges.push(n),
  });
  const agentRoom = room({ roomId: "!agent:agentstudio.local", name: "agents_concierge", bridge: { id: "agentstudio-agents" } });
  const leoRoom = room({ roomId: "!leo", name: "Leo Park", bridge: { id: "demo", displayname: "Demo" } });
  const say = (r: ReturnType<typeof room>, content: Record<string, unknown>, ageMs = 100, sender = "@agents_concierge:agentstudio.local") => {
    const message = toChatMessage(ev({ sender, senderName: r === leoRoom ? "Leo Park" : "Concierge", ts: Date.now(), content }), r, ME)!;
    live({ message, room: r, ageMs });
  };
  return { c, delivered, badges, approvals, approvalsState, agents, rows, agentRoom, leoRoom, say, setPrefs: (n: NotificationPrefs) => (p = n), cards };
}

describe("NotificationCenter", () => {
  it("announces an approval card once, as an approval, after loading it", async () => {
    const t = center();
    const card = { msgtype: "m.text", body: "Approval requested", "com.agentstudio.approval": { v: 1, approval_id: "apr_1" } };
    t.say(t.agentRoom, card);
    t.say(t.agentRoom, card); // the same card again (e.g. an edit) is not announced twice
    await sleep(0);
    expect(t.approvals.load).toHaveBeenCalledTimes(1);
    expect(t.delivered).toHaveLength(1);
    expect(t.delivered[0]).toMatchObject({ kind: "approval", title: "Book the 6pm flight to Toronto for $412?", body: "Concierge" });
  });

  it("does not announce approval cards that arrive as history", async () => {
    const t = center();
    t.say(t.agentRoom, { msgtype: "m.text", body: "x", "com.agentstudio.approval": { v: 1, approval_id: "apr_1" } }, HISTORY_AGE_MS + 1);
    await sleep(0);
    expect(t.approvals.load).not.toHaveBeenCalled();
    expect(t.delivered).toHaveLength(0);
  });

  it("announces agent replies by agent name and people's messages by chat name", () => {
    const t = center();
    t.say(t.agentRoom, { msgtype: "m.text", body: "Found a flight" });
    t.say(t.leoRoom, { msgtype: "m.text", body: "Hi!" }, 100, "@demo_leo:agentstudio.local");
    expect(t.delivered.map((n) => [n.kind, n.title, n.body])).toEqual([
      ["agent_message", "Concierge", "Found a flight"],
      ["message", "Leo Park", "Hi!"],
    ]);
  });

  it("stops announcing a muted agent", async () => {
    const t = center();
    t.setPrefs(prefs({ "agentstudio-agents:concierge": "mute" }));
    t.say(t.agentRoom, { msgtype: "m.text", body: "Found a flight" });
    t.say(t.agentRoom, { msgtype: "m.text", body: "x", "com.agentstudio.approval": { v: 1, approval_id: "apr_1" } });
    await sleep(0);
    expect(t.delivered).toHaveLength(0);
  });

  it("keeps the badge in step with approvals and agent unread counts, and clears it on dispose", () => {
    const t = center();
    expect(t.badges).toEqual([0]);
    t.approvalsState.set({ count: 1 });
    t.rows.set([{ isAgent: true, unread: 2 } as ChatRow, { isAgent: false, unread: 4 } as ChatRow]);
    t.rows.set([{ isAgent: true, unread: 2 } as ChatRow]); // same count: no update
    expect(t.badges).toEqual([0, 1, 3]);
    t.c.dispose();
    expect(t.badges).toEqual([0, 1, 3, 0]);
  });

  it("announces an agent that starts needing a sign-in, but not the state it had at startup", () => {
    const connectors = new Store<ConnectorHealth[] | null>(null);
    const grok = agent({ id: "agentstudio-agents:grok", connection_id: "agentstudio-agents:grok", name: "Grok Bot" });
    const muse = agent({ id: "agentstudio-agents:muse", connection_id: "agentstudio-agents:muse", name: "Muse" });
    const t = center({ connectors });
    t.agents.set({ items: [grok, muse], loading: false });
    connectors.set([
      { connectionId: grok.connection_id, status: "ready" },
      { connectionId: muse.connection_id, status: "needs_login" }, // already broken at startup
    ]);
    expect(t.delivered).toHaveLength(0);
    connectors.set([
      { connectionId: grok.connection_id, status: "needs_login" },
      { connectionId: muse.connection_id, status: "needs_login" },
    ]);
    expect(t.delivered).toEqual([expect.objectContaining({ kind: "agent_problem", title: "Grok Bot", open: { view: "connect" } })]);
    connectors.set([{ connectionId: grok.connection_id, status: "needs_login" }, { connectionId: muse.connection_id, status: "needs_login", message: "again" }]);
    expect(t.delivered).toHaveLength(1); // no repeat while it stays broken
  });

  it("delivers nothing after dispose", () => {
    const t = center();
    t.c.dispose();
    t.say(t.agentRoom, { msgtype: "m.text", body: "late" });
    expect(t.delivered).toHaveLength(0);
  });
});
