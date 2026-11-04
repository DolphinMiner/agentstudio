import { describe, expect, it } from "vitest";
import { askAgent, buildAskContent, buildAskQuote, isContactAddressOnly, type AskSourceMessage } from "../src/ask.js";

const T0 = 1_762_070_000_000;
const MIN = 60_000;

function msg(senderName: string, body: string, ts: number, own = false, sender = `@x_${senderName}:agentstudio.local`): AskSourceMessage {
  return { sender, senderName, own, body, ts };
}

describe("buildAskQuote", () => {
  it("takes the anchor plus up to 4 prior messages, oldest first", () => {
    const msgs = [0, 1, 2, 3, 4, 5, 6].map((i) => msg("Leo Park", `m${i}`, T0 + i * MIN));
    const lines = buildAskQuote(msgs, 6);
    expect(lines.map((l) => l.text)).toEqual(["m2", "m3", "m4", "m5", "m6"]);
    // anchor in the middle: later messages are never included
    expect(buildAskQuote(msgs, 1).map((l) => l.text)).toEqual(["m0", "m1"]);
  });

  it("stops at a gap of more than 10 minutes", () => {
    const msgs = [
      msg("Leo Park", "old", T0),
      msg("Leo Park", "Hey! Long time", T0 + 11 * MIN),
      msg("Leo Park", "Are we still on for 7:15?", T0 + 20 * MIN),
    ];
    const lines = buildAskQuote(msgs, 2);
    expect(lines.map((l) => l.text)).toEqual(["Hey! Long time", "Are we still on for 7:15?"]);
    expect(lines[1]).toEqual({ speaker: "Leo Park", own: false, ts: T0 + 20 * MIN, text: "Are we still on for 7:15?" });
  });

  it("anonymizes phone/email-only senders and labels own lines Me", () => {
    const msgs = [
      msg("Mia Chen", "Chapter 4 tonight?", T0),
      msg("+1 555 0101", "I'm in", T0 + 1000, false, "@demo_+15550101:agentstudio.local"),
      msg("Demo User", "Me too", T0 + 2000, true, "@u_1:agentstudio.local"),
      msg("bob@example.com", "And me", T0 + 3000, false, "@demo_bob:agentstudio.local"),
      msg("+1 555 0101", "great", T0 + 4000, false, "@demo_+15550101:agentstudio.local"),
    ];
    const lines = buildAskQuote(msgs, 4);
    expect(lines.map((l) => [l.speaker, l.own])).toEqual([
      ["Mia Chen", false],
      ["Person 1", false],
      ["Me", true],
      ["Person 2", false],
      ["Person 1", false],
    ]);
  });

  it("caps each line at 2000 characters", () => {
    const lines = buildAskQuote([msg("Leo Park", "x".repeat(5000), T0)], 0);
    expect(lines[0]!.text).toHaveLength(2000);
    expect(lines[0]!.text.endsWith("…")).toBe(true);
  });

  it("returns [] for a bad anchor index", () => {
    expect(buildAskQuote([], 0)).toEqual([]);
  });
});

describe("isContactAddressOnly", () => {
  it.each([
    ["+1 555 0101", true],
    ["+15550101", true],
    ["(555) 010-1234", true],
    ["leo@example.com", true],
    ["Leo Park", false],
    ["Agent 007", false],
    ["2024", false],
  ])("%s -> %s", (name, want) => expect(isContactAddressOnly(name)).toBe(want));
});

describe("buildAskContent", () => {
  it("produces the documented com.agentstudio.ask content", () => {
    const lines = [{ speaker: "Leo Park", own: false, ts: 1762070000000, text: "Are we still on for 7:15?" }];
    const c = buildAskContent({ task_id: "tsk_1", app: "Demo", chat: "Leo Park", request: "Draft a reply" }, lines);
    expect(c).toEqual({
      msgtype: "m.text",
      body: "Ask: Draft a reply\n\nFrom Leo Park in Demo:\n> Leo Park: Are we still on for 7:15?",
      "com.agentstudio.ask": {
        v: 1,
        task_id: "tsk_1",
        app: "Demo",
        chat: "Leo Park",
        request: "Draft a reply",
        lines,
      },
    });
  });

  it("quotes multi-line text and defaults an empty request", () => {
    const c = buildAskContent(
      { task_id: "t", app: "Demo", chat: "Mom", request: "  " },
      [{ speaker: "Mom", own: false, ts: 1, text: "a\nb" }],
    );
    expect(c.body).toBe("Ask: Draft a reply\n\nFrom Mom in Demo:\n> Mom: a\n> b");
    expect(c["com.agentstudio.ask"].request).toBe("Draft a reply");
  });
});

describe("askAgent", () => {
  it("creates the task then sends the ask into the agent room", async () => {
    const order: string[] = [];
    const origin = { room_id: "!leo", network: "demo", chat_name: "Leo Park", anchor_event_id: "$a" };
    const res = await askAgent(
      {
        tasks: {
          create: async (agentId, request, o, title) => {
            order.push(`create:${agentId}:${request}:${o.room_id}:${title}`);
            return { id: "tsk_9" } as never;
          },
        },
        matrix: {
          sendContent: async (roomId, content) => {
            order.push(`send:${roomId}:${(content["com.agentstudio.ask"] as { task_id: string }).task_id}`);
            return { ok: true, eventId: "$ask" };
          },
        },
      },
      { agent: { id: "ag", room_id: "!agent" }, request: "Draft a reply", origin, app: "Demo", lines: [{ speaker: "Leo Park", own: false, ts: 1, text: "Are we still on for 7:15?" }] },
    );
    expect(order).toEqual(["create:ag:Draft a reply:!leo:Are we still on for 7:15?", "send:!agent:tsk_9"]);
    expect(res.send).toEqual({ ok: true, eventId: "$ask" });
  });
});
