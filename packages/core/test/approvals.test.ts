import { describe, expect, it } from "vitest";
import { ApiClient, ApiError } from "../src/api.js";
import { ApprovalsStore, approvalStateText, formatExpiry, isExpired } from "../src/approvals.js";
import { approval, err, fakeFetch, makeSession } from "./fakes.js";

function setup(handler: Parameters<typeof fakeFetch>[0]) {
  const { fetch, calls } = fakeFetch(handler);
  const api = new ApiClient({ baseUrl: "http://x.test", fetch });
  api.setSession(makeSession(1));
  return { store: new ApprovalsStore(api, { intervalMs: 60_000 }), calls };
}

describe("ApprovalsStore.decide", () => {
  it("sends choice, version and an idempotency key, then drops it from pending", async () => {
    const decided = approval({ version: 2, state: "decided", decision: { choice: "book", decided_at: "x" }, delivery_state: "delivered" });
    const { store, calls } = setup((c) =>
      c.path.startsWith("/v1/approvals?") ? { status: 200, body: { approvals: [approval()] } } : { status: 200, body: decided },
    );
    await store.refresh();
    expect(store.pendingCount).toBe(1);
    const res = await store.decide("apr_1", "book");
    expect(res).toEqual(decided);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe("/v1/approvals/apr_1/decision");
    expect(post.body).toMatchObject({ choice: "book", version: 1 });
    expect(post.body.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.pendingCount).toBe(0);
    expect(store.getApproval("apr_1")).toEqual(decided);
    store.stop();
  });

  it("retries once with the current version when still pending after a conflict", async () => {
    const bumped = approval({ version: 5 });
    const decided = approval({ version: 6, state: "decided", decision: { choice: "book", decided_at: "x" } });
    const posts: any[] = [];
    const { store } = setup((c) => {
      if (c.method === "GET") return { status: 200, body: { approvals: [approval()] } };
      posts.push(c.body);
      return c.body.version === 1 ? err(409, "version_conflict", bumped) : { status: 200, body: decided };
    });
    await store.refresh();
    expect(await store.decide("apr_1", "book")).toEqual(decided);
    expect(posts.map((p) => p.version)).toEqual([1, 5]);
    expect(posts[0].idempotency_key).not.toBe(posts[1].idempotency_key);
    store.stop();
  });

  it("throws and shows the server state when someone else already decided", async () => {
    const other = approval({ version: 2, state: "decided", decision: { choice: "skip", decided_at: "x" } });
    let posts = 0;
    const { store } = setup((c) => {
      if (c.method === "GET") return { status: 200, body: { approvals: [approval()] } };
      posts++;
      return err(409, "version_conflict", other);
    });
    await store.refresh();
    const e = await store.decide("apr_1", "book").catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.isConflict).toBe(true);
    expect(posts).toBe(1);
    expect(store.getApproval("apr_1")).toEqual(other);
    expect(store.pendingCount).toBe(0);
    expect(approvalStateText(store.getApproval("apr_1")!)).toBe("Declined: Don't book");
    store.stop();
  });

  it("retries a network failure with the same idempotency key", async () => {
    const keys: string[] = [];
    let n = 0;
    const { store } = setup((c) => {
      if (c.method === "GET") return { status: 200, body: approval() };
      keys.push(c.body.idempotency_key);
      if (n++ === 0) throw new TypeError("offline");
      return { status: 200, body: approval({ version: 2, state: "decided", decision: { choice: "book", decided_at: "x" } }) };
    });
    await store.decide("apr_1", "book"); // loads apr_1 first since it's not cached
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    store.stop();
  });

  it("propagates 410 expired", async () => {
    const { store } = setup((c) => (c.method === "GET" ? { status: 200, body: approval() } : err(410, "expired")));
    await expect(store.decide("apr_1", "book")).rejects.toMatchObject({ status: 410, code: "expired" });
    store.stop();
  });

  it("dedupes concurrent loads and ignores older versions", async () => {
    let gets = 0;
    const { store } = setup(() => {
      gets++;
      return { status: 200, body: approval({ version: 3 }) };
    });
    await Promise.all([store.load("apr_1"), store.load("apr_1")]);
    expect(gets).toBe(1);
    expect(store.getApproval("apr_1")!.version).toBe(3);
  });
});

describe("formatExpiry / state text", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  const at = (ms: number) => new Date(now + ms).toISOString();
  it.each([
    [null, null],
    [at(44 * 60_000), "44 min left"],
    [at(43 * 60_000 + 30_000), "44 min left"],
    [at(20_000), "1 min left"],
    [at(60 * 60_000), "1 h left"],
    [at(65 * 60_000), "1 h 5 min left"],
    [at(0), "Expired"],
    [at(-5000), "Expired"],
  ])("%s -> %s", (exp, want) => expect(formatExpiry(exp, now)).toBe(want));

  it("describes card states", () => {
    expect(approvalStateText(approval({ state: "decided", decision: { choice: "book", decided_at: "x" } }))).toBe("Approved: Book");
    expect(approvalStateText(approval())).toBeNull();
    expect(approvalStateText(approval({ expires_at: at(-1) }), now)).toBe("Expired");
    expect(isExpired(approval({ expires_at: at(1000) }), now)).toBe(false);
    expect(approvalStateText(approval({ state: "expired" }))).toBe("Expired");
    expect(approvalStateText(approval({ state: "cancelled" }))).toBe("Cancelled");
  });
});
