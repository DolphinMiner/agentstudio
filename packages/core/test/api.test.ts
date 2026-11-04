import { describe, expect, it } from "vitest";
import { ApiClient, ApiError } from "../src/api.js";
import { err, fakeFetch, makeSession, sleep } from "./fakes.js";

const BASE = "http://127.0.0.1:18090";

describe("ApiClient", () => {
  it("sends bearer auth and parses list responses", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { agents: [] } }));
    const api = new ApiClient({ baseUrl: BASE + "/", fetch });
    api.setSession(makeSession(1));
    expect(await api.agents()).toEqual([]);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/v1/agents", auth: "Bearer at1" });
  });

  it("reads the base URL getter on every request", async () => {
    let base = "http://a.test";
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { networks: [] } }));
    const api = new ApiClient({ baseUrl: () => base, fetch });
    await api.networks();
    base = "http://b.test";
    await api.networks();
    expect(calls).toHaveLength(2);
    expect(api.baseUrl).toBe("http://b.test");
  });

  it("maps error bodies to ApiError with code, status and current", async () => {
    const current = { id: "apr_1", version: 3 };
    const { fetch } = fakeFetch(() => err(409, "version_conflict", current));
    const api = new ApiClient({ baseUrl: BASE, fetch });
    api.setSession(makeSession(1));
    const e = await api
      .decideApproval("apr_1", { choice: "book", version: 1, idempotency_key: "k" })
      .catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 409, code: "version_conflict", current });
    expect(e.isConflict).toBe(true);
  });

  it("maps network failures to network_error", async () => {
    const api = new ApiClient({
      baseUrl: BASE,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(api.health()).rejects.toMatchObject({ code: "network_error", status: 0 });
  });

  it("refreshes on 401 once for many concurrent requests (single-flight)", async () => {
    let refreshes = 0;
    const { fetch, calls } = fakeFetch(async (c) => {
      if (c.path === "/v1/auth/refresh") {
        refreshes++;
        expect(c.body).toEqual({ refresh_token: "rt1" });
        expect(c.auth).toBeUndefined();
        await sleep(10);
        return { status: 200, body: makeSession(2) };
      }
      if (c.auth !== "Bearer at2") return err(401, "unauthenticated");
      return { status: 200, body: { tasks: [] } };
    });
    const api = new ApiClient({ baseUrl: BASE, fetch });
    api.setSession(makeSession(1));
    const changes: string[] = [];
    api.onSessionChange((s, reason) => changes.push(`${reason}:${s?.refresh_token}`));

    const results = await Promise.all([api.tasks(), api.tasks("open"), api.tasks(), api.tasks()]);
    expect(results).toEqual([[], [], [], []]);
    expect(refreshes).toBe(1);
    expect(changes).toEqual(["refreshed:rt2"]);
    expect(api.getSession()?.access_token).toBe("at2");
    // 4 failed + 1 refresh + 4 retries
    expect(calls).toHaveLength(9);
  });

  it("refreshes proactively before access_expires_at", async () => {
    const now = Date.parse("2026-11-02T12:00:00Z");
    const { fetch, calls } = fakeFetch((c) =>
      c.path === "/v1/auth/refresh"
        ? { status: 200, body: makeSession(2, { now }) }
        : { status: 200, body: { user: { id: "usr_1" } } },
    );
    const api = new ApiClient({ baseUrl: BASE, fetch, now: () => now });
    api.setSession(makeSession(1, { now, expiresInMs: 30_000 })); // inside the 60 s skew
    await api.me();
    expect(calls.map((c) => c.path)).toEqual(["/v1/auth/refresh", "/v1/me"]);
    expect(calls[1]!.auth).toBe("Bearer at2");
  });

  it("clears the session when the refresh token is rejected", async () => {
    const { fetch } = fakeFetch((c) =>
      c.path === "/v1/auth/refresh" ? err(401, "unauthenticated") : err(401, "unauthenticated"),
    );
    const api = new ApiClient({ baseUrl: BASE, fetch });
    api.setSession(makeSession(1));
    const reasons: string[] = [];
    api.onSessionChange((_s, r) => reasons.push(r));
    await expect(api.me()).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
    expect(api.getSession()).toBeNull();
    expect(reasons).toEqual(["revoked"]);
  });

  it("keeps the session when refresh fails with a network error", async () => {
    let n = 0;
    const api = new ApiClient({
      baseUrl: BASE,
      fetch: fakeFetch((c) => {
        if (c.path === "/v1/auth/refresh") throw new TypeError("offline");
        n++;
        return err(401, "unauthenticated");
      }).fetch,
    });
    api.setSession(makeSession(1));
    await expect(api.me()).rejects.toMatchObject({ code: "network_error" });
    expect(n).toBe(1);
    expect(api.getSession()?.refresh_token).toBe("rt1");
  });

  it("does not send auth for sign-in routes and throws when signed out", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 204 }));
    const api = new ApiClient({ baseUrl: BASE, fetch });
    await api.startEmailSignIn("x@example.com");
    expect(calls[0]).toMatchObject({ path: "/v1/auth/email/start", auth: undefined, body: { email: "x@example.com" } });
    await expect(api.agents()).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("encodes path and query parameters", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { messages: [] } }));
    const api = new ApiClient({ baseUrl: BASE, fetch });
    await api.devOutbox("a+b@example.com");
    expect(calls[0]!.path).toBe("/v1/dev/outbox?email=a%2Bb%40example.com");
    api.setSession(makeSession(1));
    await api.deleteConnection("demo:demo-abc").catch(() => {});
    expect(calls[1]!.path).toBe("/v1/connections/demo%3Ademo-abc");
  });
});
