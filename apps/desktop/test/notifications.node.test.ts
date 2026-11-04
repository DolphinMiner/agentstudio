import { describe, expect, it } from "vitest";
import { readBadgeCount, readNotification, readNotificationPrefs, withAgentMode } from "../src/shared/notifications";

describe("notification settings", () => {
  it("default to on with every agent on all", () => {
    expect(readNotificationPrefs(undefined)).toEqual({ enabled: true, agents: {} });
    expect(readNotificationPrefs("junk")).toEqual({ enabled: true, agents: {} });
  });
  it("keep valid agent modes and drop the rest", () => {
    expect(readNotificationPrefs({ enabled: false, agents: { a: "mute", b: "approvals", c: "all", d: "loud", "": "mute" } })).toEqual({
      enabled: false,
      agents: { a: "mute", b: "approvals" },
    });
  });
  it("store only modes other than all", () => {
    const p = withAgentMode({ enabled: true, agents: {} }, "a", "mute");
    expect(p.agents).toEqual({ a: "mute" });
    expect(withAgentMode(p, "a", "all").agents).toEqual({});
  });
});

describe("notification requests from the renderer", () => {
  const ok = { kind: "approval", priority: "high", title: "Book it?", body: "Concierge", open: { view: "approvals" }, roomId: "!r" };
  it("accept a well-formed request", () => {
    expect(readNotification(ok)).toEqual(ok);
    expect(readNotification({ ...ok, open: { view: "inbox", roomId: "!r" } })?.open).toEqual({ view: "inbox", roomId: "!r" });
  });
  it("reject unknown kinds, screens and empty titles", () => {
    expect(readNotification(null)).toBeNull();
    expect(readNotification({ ...ok, kind: "spam" })).toBeNull();
    expect(readNotification({ ...ok, priority: "urgent" })).toBeNull();
    expect(readNotification({ ...ok, open: { view: "settings" } })).toBeNull();
    expect(readNotification({ ...ok, title: " " })).toBeNull();
    expect(readNotification({ ...ok, body: 3 })).toBeNull();
  });
  it("shorten long text and drop bad room ids", () => {
    const n = readNotification({ ...ok, title: "t".repeat(500), body: "b".repeat(900), roomId: 7, open: { view: "inbox", roomId: "" } })!;
    expect(n.title).toHaveLength(200);
    expect(n.body).toHaveLength(500);
    expect(n.roomId).toBeUndefined();
    expect(n.open).toEqual({ view: "inbox" });
  });
  it("badge counts are whole, non-negative and capped", () => {
    expect(readBadgeCount(3)).toBe(3);
    expect(readBadgeCount(2.7)).toBe(2);
    expect(readBadgeCount(-1)).toBe(0);
    expect(readBadgeCount("4")).toBe(0);
    expect(readBadgeCount(Infinity)).toBe(0);
    expect(readBadgeCount(1e9)).toBe(9999);
  });
});
