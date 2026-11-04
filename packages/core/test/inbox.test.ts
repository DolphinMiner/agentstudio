import { describe, expect, it } from "vitest";
import { InboxStore, deriveChatRows, filterChatRows } from "../src/inbox.js";
import { ChangeEmitter, Store } from "../src/store.js";
import type { Agent } from "../src/types.js";
import { ME, agent, ev, room } from "./fakes.js";

const BOT = "@demobot:agentstudio.local";

function fixture() {
  const mom = room({
    roomId: "!mom",
    name: "Mom",
    bridge: { id: "demo", displayname: "Demo" },
    members: [{ userId: BOT, name: "bot", membership: "join" }, { userId: "@demo_mom:agentstudio.local", name: "Mom", membership: "join" }],
    events: [ev({ sender: "@demo_mom:agentstudio.local", senderName: "Mom", ts: 100, body: "Did you eat yet?" })],
  });
  const leo = room({
    roomId: "!leo",
    name: "Leo Park",
    bridge: { id: "demo", displayname: "Demo" },
    events: [
      ev({ id: "$l1", sender: "@demo_leo:agentstudio.local", senderName: "Leo Park", ts: 200, body: "Hey! Long time" }),
      ev({ id: "$l2", sender: "@demo_leo:agentstudio.local", senderName: "Leo Park", ts: 300, body: "Are we still on\nfor 7:15?" }),
    ],
    readUpTo: "$l1",
  });
  const concierge = room({
    roomId: "!agent:agentstudio.local",
    name: "agents_concierge",
    bridge: { id: "agentstudio-agents", displayname: "AgentStudio Agents" },
    events: [ev({ sender: ME, senderName: "Me", ts: 250, body: "Find me a flight" })],
  });
  const mgmt = room({ roomId: "!mgmt", name: "Demo bridge bot", members: [{ userId: BOT, name: "Demo bridge bot", membership: "join" }], events: [ev({ sender: BOT, ts: 999, body: "hi" })] });
  const invite = room({ roomId: "!inv", name: "Book Club", membership: "invite", bridge: { id: "demo" } });
  return [mom, leo, concierge, mgmt, invite];
}

describe("deriveChatRows", () => {
  it("builds sorted rows, hides management/invite rooms, joins agents", () => {
    const agents = [agent({ status: "working", status_text: "Searching flights", pending_approvals: 1 })];
    const rows = deriveChatRows(fixture(), ME, agents);
    expect(rows.map((r) => r.name)).toEqual(["Leo Park", "Concierge", "Mom"]);
    const [leo, conc, mom] = rows;
    expect(leo).toMatchObject({ network: "demo", networkLabel: "Demo", lastMessage: "Are we still on for 7:15?", lastSender: "Leo Park", lastTs: 300, unread: 1, isAgent: false, agentId: null, needsYou: false });
    expect(conc).toMatchObject({ network: "agentstudio-agents", networkLabel: "Agent", isAgent: true, agentId: "agentstudio-agents:concierge", agentStatus: "working", agentStatusText: "Searching flights", needsYou: true, unread: 0, lastSender: "Me", lastOwn: true });
    expect(mom!.unread).toBe(1);
  });

  it("filters people and agents", () => {
    const rows = deriveChatRows(fixture(), ME, [agent()]);
    expect(filterChatRows(rows, "agents").map((r) => r.name)).toEqual(["Concierge"]);
    expect(filterChatRows(rows, "people").map((r) => r.name)).toEqual(["Leo Park", "Mom"]);
    expect(filterChatRows(rows, "all")).toHaveLength(3);
  });

  it("works for agent rooms not yet in the agents list", () => {
    const rows = deriveChatRows(fixture(), ME, []);
    expect(rows.find((r) => r.isAgent)).toMatchObject({ name: "agents_concierge", agentId: null, needsYou: false, agentStatusText: null });
  });
});

describe("InboxStore", () => {
  it("keeps a stable snapshot and recomputes on matrix or agents changes", async () => {
    const rooms = fixture();
    const emitter = new ChangeEmitter();
    const matrix = { subscribe: emitter.subscribe, version: emitter.version, getRooms: () => rooms, userId: ME };
    const agents = new Store<{ items: Agent[] }>({ items: [] });
    const inbox = new InboxStore({ matrix, agents });
    let notified = 0;
    inbox.rows.subscribe(() => notified++);

    const a = inbox.rows.getSnapshot();
    expect(inbox.rows.getSnapshot()).toBe(a);
    expect(inbox.filtered("agents")).toBe(inbox.filtered("agents"));

    agents.set({ items: [agent({ pending_approvals: 2 })] });
    const b = inbox.rows.getSnapshot();
    expect(b).not.toBe(a);
    expect(b.find((r) => r.isAgent)!.needsYou).toBe(true);

    rooms.splice(0, 1); // Mom left
    emitter.emit();
    expect(inbox.rows.getSnapshot().map((r) => r.name)).toEqual(["Leo Park", "Concierge"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(notified).toBeGreaterThan(0);
    inbox.dispose();
  });
});
