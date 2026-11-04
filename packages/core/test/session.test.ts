import { describe, expect, it } from "vitest";
import { ApiClient } from "../src/api.js";
import { KeyValueSessionStore, MemorySessionStore, SessionManager } from "../src/session.js";
import { err, fakeFetch, makeSession } from "./fakes.js";

describe("SessionManager", () => {
  it("signs in, persists, rotates on refresh and logs out", async () => {
    const { fetch, calls } = fakeFetch((c) => {
      switch (c.path) {
        case "/v1/auth/email/start":
          return { status: 204 };
        case "/v1/auth/email/verify":
          return { status: 200, body: makeSession(1) };
        case "/v1/auth/refresh":
          return { status: 200, body: makeSession(2) };
        case "/v1/auth/logout":
          return { status: 204 };
        default:
          return err(404, "not_found");
      }
    });
    const api = new ApiClient({ baseUrl: "http://x.test", fetch });
    const store = new MemorySessionStore();
    const sm = new SessionManager({ api, store, deviceName: "AgentStudio Test" });
    expect(await sm.init()).toBeNull();
    expect(sm.getSnapshot().status).toBe("signed_out");

    const seen: (string | null)[] = [];
    sm.onChange((s) => seen.push(s?.refresh_token ?? null));

    await sm.startSignIn(" a@example.com ");
    const s = await sm.verifySignIn("a@example.com", " 123456 ");
    expect(s.access_token).toBe("at1");
    expect(calls[1]!.body).toEqual({ email: "a@example.com", code: "123456", device_name: "AgentStudio Test" });
    expect((await store.load())?.refresh_token).toBe("rt1");

    await sm.refresh();
    await sm.flush();
    expect((await store.load())?.refresh_token).toBe("rt2");

    await sm.logout();
    expect(calls.at(-1)).toMatchObject({ path: "/v1/auth/logout", auth: "Bearer at2" });
    expect(await store.load()).toBeNull();
    expect(sm.getSnapshot()).toMatchObject({ status: "signed_out", session: null });
    expect(seen).toEqual(["rt1", "rt2", null]);
  });

  it("restores a saved session and clears it locally even if logout fails", async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError("offline");
    });
    const api = new ApiClient({ baseUrl: "http://x.test", fetch });
    const store = new MemorySessionStore(makeSession(7));
    const sm = new SessionManager({ api, store, deviceName: "d" });
    expect((await sm.init())?.access_token).toBe("at7");
    expect(api.getSession()?.access_token).toBe("at7");
    await sm.logout();
    expect(await store.load()).toBeNull();
  });

  it("KeyValueSessionStore round-trips and tolerates garbage", async () => {
    const m = new Map<string, string>();
    const kv = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    const st = new KeyValueSessionStore(kv);
    await st.save(makeSession(1));
    expect((await st.load())?.session_id).toBe("ses_1");
    m.set("agentstudio.session", "{not json");
    expect(await st.load()).toBeNull();
    await st.clear();
    expect(m.size).toBe(0);
  });
});
