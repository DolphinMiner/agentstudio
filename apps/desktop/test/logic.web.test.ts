import { describe, expect, it } from "vitest";
import type { Agent, Task } from "@agentstudio/core";
import { askableAgents, groupTasks, taskColumn } from "../src/renderer/src/lib/logic";

const task = (id: string, state: Task["state"], updated_at: string) => ({ id, state, updated_at }) as Task;

describe("tasks board", () => {
  it("maps states to columns", () => {
    expect(taskColumn("pending")).toBe("pending");
    expect(taskColumn("answered")).toBe("answered");
    for (const s of ["done", "cancelled", "failed"] as const) expect(taskColumn(s)).toBe("done");
  });
  it("groups and sorts newest first", () => {
    const g = groupTasks([
      task("a", "pending", "2026-01-01T00:00:00Z"),
      task("b", "pending", "2026-01-02T00:00:00Z"),
      task("c", "failed", "2026-01-01T00:00:00Z"),
    ]);
    expect(g.pending.map((t) => t.id)).toEqual(["b", "a"]);
    expect(g.answered).toEqual([]);
    expect(g.done.map((t) => t.id)).toEqual(["c"]);
  });
});

it("only offers agents with a room and the ask capability", () => {
  const a = (id: string, room_id: string | null, capabilities: Agent["capabilities"]) =>
    ({ id, room_id, capabilities }) as Agent;
  const out = askableAgents([a("1", "!r", ["chat", "ask"]), a("2", null, ["ask"]), a("3", "!s", ["chat"])]);
  expect(out.map((x) => x.id)).toEqual(["1"]);
});
