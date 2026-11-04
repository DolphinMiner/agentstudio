import { describe, expect, it } from "vitest";
import { ApiClient } from "../src/api.js";
import { TasksStore } from "../src/tasks.js";
import { err, fakeFetch, makeSession, task } from "./fakes.js";

function setup(handler: Parameters<typeof fakeFetch>[0]) {
  const { fetch, calls } = fakeFetch(handler);
  const api = new ApiClient({ baseUrl: "http://x.test", fetch });
  api.setSession(makeSession(1));
  return { store: new TasksStore(api), calls };
}

describe("TasksStore", () => {
  it("creates a task with an idempotency key and lists it", async () => {
    const origin = task().origin;
    const { store, calls } = setup(() => ({ status: 200, body: task({ state: "pending", answer: null }) }));
    const t = await store.create("agentstudio-agents:concierge", "Draft a reply", origin);
    expect(t.state).toBe("pending");
    expect(calls[0]!.body).toMatchObject({ agent_id: "agentstudio-agents:concierge", request_text: "Draft a reply", origin });
    expect(typeof calls[0]!.body.idempotency_key).toBe("string");
    expect(store.byState("pending")).toHaveLength(1);
  });

  it("markSent returns the current task when a conflict shows it is already done", async () => {
    const done = task({ version: 3, state: "done", sent_draft_index: 0 });
    let posts = 0;
    const { store } = setup((c) => {
      if (c.method === "GET") return { status: 200, body: { tasks: [task()] } };
      posts++;
      return err(409, "version_conflict", done);
    });
    await store.refresh();
    expect(await store.markSent("tsk_1", 0)).toEqual(done);
    expect(posts).toBe(1);
    expect(store.get("tsk_1")).toEqual(done);
  });

  it("markSent retries with the new version when the task is still answered", async () => {
    const versions: number[] = [];
    const { store } = setup((c) => {
      if (c.method === "GET") return { status: 200, body: { tasks: [task()] } };
      versions.push(c.body.version);
      return c.body.version === 1 ? err(409, "version_conflict", task({ version: 2 })) : { status: 200, body: task({ version: 3, state: "done", sent_draft_index: 1 }) };
    });
    const t = await store.markSent("tsk_1", 1); // not cached: refreshes first
    expect(versions).toEqual([1, 2]);
    expect(t.state).toBe("done");
  });

  it("cancel rethrows a conflict when the task already failed", async () => {
    const { store } = setup((c) =>
      c.method === "GET" ? { status: 200, body: { tasks: [task()] } } : err(409, "version_conflict", task({ version: 2, state: "failed" })),
    );
    await expect(store.cancel("tsk_1")).rejects.toMatchObject({ code: "version_conflict" });
    expect(store.get("tsk_1")!.state).toBe("failed");
  });
});
