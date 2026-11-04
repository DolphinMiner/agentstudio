import { describe, expect, it } from "vitest";
import type { Room } from "matrix-js-sdk";
import { isBridgeBot, isBridgeGhost, parseApproval, shouldAutoJoin } from "../src/events.js";
import {
  classifyRoom,
  getBridgeInfo,
  mapStatus,
  roomDisplayName,
  roomMessages,
  toChatMessage,
  unreadCount,
  type RoomLike,
} from "../src/matrix.js";
import { ME, ev, room } from "./fakes.js";

// Compile-time check: matrix-js-sdk's Room satisfies RoomLike.
const _roomIsRoomLike: (r: Room) => RoomLike = (r) => r;
void _roomIsRoomLike;

const BOT = "@demobot:agentstudio.local";
const MOM = "@demo_mom:agentstudio.local";

describe("auto-join policy", () => {
  it.each([
    [BOT, true],
    ["@agentsbot:agentstudio.local", true],
    [MOM, true],
    ["@agents_concierge:agentstudio.local", true],
    ["@demobot:evil.example", false],
    ["@demo_mom:evil.example", false],
    ["@alice:agentstudio.local", false],
    ["@robot_x:agentstudio.local", false],
    [undefined, false],
  ])("%s -> %s", (inviter, want) => expect(shouldAutoJoin(inviter, "agentstudio.local")).toBe(want));

  it("recognises bots and ghosts", () => {
    expect(isBridgeBot(BOT, "agentstudio.local")).toBe(true);
    expect(isBridgeGhost(BOT, "agentstudio.local")).toBe(false);
    expect(isBridgeGhost(MOM, "agentstudio.local")).toBe(true);
  });
});

describe("classifyRoom", () => {
  it("reads the network from m.bridge protocol.id and displayname", () => {
    const r = room({ roomId: "!mom", name: "Mom", bridge: { id: "demo", displayname: "Demo" }, members: [{ userId: BOT, name: "bot", membership: "join" }] });
    expect(getBridgeInfo(r)).toEqual({ protocolId: "demo", protocolName: "Demo", bot: BOT });
    expect(classifyRoom(r, ME)).toEqual({ network: "demo", networkLabel: "Demo", isAgentRoom: false, isManagement: false, hidden: false });
  });

  it("also reads uk.half-shot.bridge, and labels agent rooms 'Agent'", () => {
    const r = room({ roomId: "!a", name: "Concierge", bridge: { id: "agentstudio-agents", displayname: "AgentStudio Agents", type: "uk.half-shot.bridge" } });
    expect(classifyRoom(r, ME)).toMatchObject({ network: "agentstudio-agents", networkLabel: "Agent", isAgentRoom: true, hidden: false });
  });

  it("hides management rooms (DM with a bridge bot, no bridge info)", () => {
    const r = room({ roomId: "!m", name: "Demo bridge bot", members: [{ userId: BOT, name: "Demo bridge bot", membership: "join" }] });
    expect(classifyRoom(r, ME)).toMatchObject({ network: "matrix", isManagement: true, hidden: true });
  });

  it("treats plain rooms as network matrix and hides non-joined rooms", () => {
    const plain = room({ roomId: "!p", name: "Friends", members: [{ userId: "@alice:agentstudio.local", name: "Alice", membership: "join" }] });
    expect(classifyRoom(plain, ME)).toMatchObject({ network: "matrix", networkLabel: "Matrix", isManagement: false, hidden: false });
    const invited = room({ roomId: "!i", name: "x", membership: "invite", bridge: { id: "demo" } });
    expect(classifyRoom(invited, ME).hidden).toBe(true);
  });

  it("derives a name from members when the room has none", () => {
    const r = room({ roomId: "!x", name: "Empty room", members: [{ userId: BOT, name: "bot", membership: "join" }, { userId: MOM, name: "Mom", membership: "join" }] });
    expect(roomDisplayName(r, ME)).toBe("Mom");
  });
});

describe("message model", () => {
  it("maps events with sender name, own flag, status and payloads", () => {
    const r = room({ roomId: "!a", name: "Concierge", members: [{ userId: "@agents_c:agentstudio.local", name: "Concierge", membership: "join" }] });
    const card = ev({
      id: "$card",
      sender: "@agents_c:agentstudio.local",
      ts: 10,
      content: { msgtype: "m.text", body: "Approval needed: x", "com.agentstudio.approval": { v: 1, approval_id: "apr_1" } },
    });
    const m = toChatMessage(card, r, ME)!;
    expect(m).toMatchObject({ id: "$card", roomId: "!a", senderName: "Concierge", own: false, body: "Approval needed: x", ts: 10, status: "sent", approval: { v: 1, approval_id: "apr_1" }, ask: null, drafts: null });

    const drafts = ev({ sender: "@agents_c:agentstudio.local", ts: 11, content: { msgtype: "m.notice", body: "d", "com.agentstudio.drafts": { v: 1, task_id: "tsk_1", drafts: [{ text: "a" }, { bad: 1 }] } } });
    expect(toChatMessage(drafts, r, ME)!.drafts).toEqual({ v: 1, task_id: "tsk_1", drafts: [{ text: "a" }] });

    const mine = ev({ sender: ME, senderName: "Demo User", ts: 12, body: "hi", status: "not_sent" });
    expect(toChatMessage(mine, r, ME)).toMatchObject({ own: true, status: "failed", senderName: "Demo User" });
  });

  it("shows what the user said in the service's app as theirs, and reads files and history", () => {
    const r = room({ roomId: "!a", name: "wiki", members: [{ userId: "@agents_w:agentstudio.local", name: "wiki", membership: "join" }] });
    const echo = ev({
      sender: "@agents_w:agentstudio.local",
      ts: 5,
      content: { msgtype: "m.text", body: "from my phone", "com.agentstudio.from_user": true, "com.agentstudio.via": "Grok Bot", "com.agentstudio.history": true },
    });
    expect(toChatMessage(echo, r, ME)).toMatchObject({ own: true, via: "Grok Bot", history: true, body: "from my phone" });

    const img = ev({
      sender: "@agents_w:agentstudio.local",
      ts: 6,
      content: { msgtype: "m.image", body: "chart.png", url: "mxc://agentstudio.local/abc", info: { mimetype: "image/png", size: 12 } },
    });
    expect(toChatMessage(img, r, ME)).toMatchObject({ own: false, via: null, history: false, file: { mxc: "mxc://agentstudio.local/abc", name: "chart.png", mime: "image/png", size: 12 } });
  });

  it("skips non-message and redacted events", () => {
    const r = room({
      roomId: "!a",
      name: "a",
      events: [
        ev({ type: "m.room.member", sender: MOM, ts: 1, content: { membership: "join" } }),
        ev({ sender: MOM, ts: 2, body: "gone", redacted: true }),
        ev({ sender: MOM, ts: 3, body: "hello" }),
      ],
    });
    expect(roomMessages(r, ME).map((m) => m.body)).toEqual(["hello"]);
  });

  it("maps SDK statuses", () => {
    expect(mapStatus(null)).toBe("sent");
    expect(mapStatus("sent")).toBe("sent");
    expect(mapStatus("sending")).toBe("sending");
    expect(mapStatus("queued")).toBe("sending");
    expect(mapStatus("encrypting")).toBe("sending");
    expect(mapStatus("not_sent")).toBe("failed");
  });

  it("ignores malformed custom payloads", () => {
    expect(parseApproval({ "com.agentstudio.approval": { approval_id: 5 } })).toBeNull();
    expect(parseApproval({ body: "x" })).toBeNull();
  });
});

describe("unreadCount", () => {
  it("counts messages from others after the read receipt", () => {
    const events = [
      ev({ id: "$1", sender: MOM, ts: 1, body: "a" }),
      ev({ id: "$2", sender: MOM, ts: 2, body: "b" }),
      ev({ id: "$3", sender: MOM, ts: 3, body: "c" }),
    ];
    expect(unreadCount(room({ roomId: "!r", name: "r", events, readUpTo: "$1" }), ME)).toBe(2);
    expect(unreadCount(room({ roomId: "!r", name: "r", events, readUpTo: "$3" }), ME)).toBe(0);
    expect(unreadCount(room({ roomId: "!r", name: "r", events }), ME)).toBe(3);
  });

  it("stops at the user's own last message", () => {
    const events = [
      ev({ sender: MOM, ts: 1, body: "a" }),
      ev({ sender: ME, ts: 2, body: "b" }),
      ev({ sender: MOM, ts: 3, body: "Echo: b" }),
      ev({ type: "m.reaction", sender: MOM, ts: 4, content: {} }),
    ];
    expect(unreadCount(room({ roomId: "!r", name: "r", events }), ME)).toBe(1);
  });
});
