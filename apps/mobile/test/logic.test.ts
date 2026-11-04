import { describe, expect, it } from "vitest";
import type { Agent, Task } from "@agentstudio/core";
import { DEFAULT_SERVER_URL, normalizeServerUrl } from "../src/lib/config";
import { askableAgents, badgeText, groupTasks, initials, rowPreview, taskColumn } from "../src/lib/logic";

describe("normalizeServerUrl", () => {
  it("falls back to the default for empty or invalid values", () => {
    expect(normalizeServerUrl(undefined)).toBe(DEFAULT_SERVER_URL);
    expect(normalizeServerUrl("  ")).toBe(DEFAULT_SERVER_URL);
    expect(normalizeServerUrl("ftp://x")).toBe(DEFAULT_SERVER_URL);
  });
  it("trims whitespace and trailing slashes", () => {
    expect(normalizeServerUrl(" https://agentstudio.example.com/ ")).toBe("https://agentstudio.example.com");
    expect(normalizeServerUrl("http://127.0.0.1:18090//")).toBe("http://127.0.0.1:18090");
  });
});

function task(id: string, state: Task["state"], updated_at: string): Task {
  return { id, state, updated_at } as Task;
}

describe("tasks board", () => {
  it("maps states to columns", () => {
    expect(taskColumn("pending")).toBe("pending");
    expect(taskColumn("answered")).toBe("answered");
    expect(taskColumn("done")).toBe("done");
    expect(taskColumn("failed")).toBe("done");
    expect(taskColumn("cancelled")).toBe("done");
  });
  it("groups and sorts newest first", () => {
    const g = groupTasks([
      task("a", "done", "2026-01-01T00:00:00Z"),
      task("b", "cancelled", "2026-01-02T00:00:00Z"),
      task("c", "pending", "2026-01-01T00:00:00Z"),
    ]);
    expect(g.done.map((t) => t.id)).toEqual(["b", "a"]);
    expect(g.pending.map((t) => t.id)).toEqual(["c"]);
    expect(g.answered).toEqual([]);
  });
});

describe("askableAgents", () => {
  it("needs a room and the ask capability", () => {
    const agents = [
      { id: "1", room_id: "!r", capabilities: ["ask"] },
      { id: "2", room_id: null, capabilities: ["ask"] },
      { id: "3", room_id: "!s", capabilities: ["approvals"] },
    ] as unknown as Agent[];
    expect(askableAgents(agents).map((a) => a.id)).toEqual(["1"]);
  });
});

describe("row helpers", () => {
  it("previews the last message, prefixing own ones", () => {
    expect(rowPreview({ lastMessage: null, lastOwn: false })).toBe("");
    expect(rowPreview({ lastMessage: "hi\n there", lastOwn: false })).toBe("hi there");
    expect(rowPreview({ lastMessage: "ok", lastOwn: true })).toBe("You: ok");
  });
  it("makes initials", () => {
    expect(initials("Leo Park")).toBe("LP");
    expect(initials("mom")).toBe("M");
    expect(initials("Book Club Friends")).toBe("BC");
    expect(initials("+1 555 0100")).toBe("#");
  });
  it("caps badges", () => {
    expect(badgeText(3)).toBe("3");
    expect(badgeText(120)).toBe("99+");
  });
});
