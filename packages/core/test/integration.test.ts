// Integration test against the running dev stack (pnpm dev:up).
// Enabled with AGENTSTUDIO_IT=1:  pnpm --filter @agentstudio/core test:it
// Signs in with an email code read from /v1/dev/outbox, starts the Matrix
// client in Node and waits for /sync. If the demo bridge is available it also
// connects the demo network and waits for the demo portals to show up.

import { describe, expect, it } from "vitest";
import { ApiClient } from "../src/api.js";
import { AgentsStore } from "../src/agents.js";
import { InboxStore } from "../src/inbox.js";
import { AgentStudioMatrix } from "../src/matrix.js";
import { MemorySessionStore, SessionManager } from "../src/session.js";
import { randomId } from "../src/platform.js";
import { sleep } from "./fakes.js";

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const enabled = env.AGENTSTUDIO_IT === "1";
const BASE = env.AGENTSTUDIO_SERVER_URL ?? "http://127.0.0.1:18090";

async function until<T>(fn: () => T | Promise<T>, what: string, timeoutMs = 20_000): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

describe.skipIf(!enabled)("integration: dev stack", () => {
  it("signs in, syncs Matrix, and (if available) sees demo portals", async () => {
    const api = new ApiClient({ baseUrl: BASE });
    const sm = new SessionManager({ api, store: new MemorySessionStore(), deviceName: "core-it" });
    await sm.init();

    const email = `core-it-${randomId().slice(0, 8)}@example.com`;
    await sm.startSignIn(email);
    const msg = await until(async () => (await api.devOutbox(email))[0], "sign-in code");
    expect(msg.code).toMatch(/^\d{6}$/);
    const session = await sm.verifySignIn(email, msg.code);
    expect(session.user.email).toBe(email);
    expect((await api.me()).id).toBe(session.user.id);
    // Typed list routes answer with the documented envelopes.
    expect(Array.isArray(await api.agents())).toBe(true);
    expect(Array.isArray(await api.approvals("all"))).toBe(true);
    expect(Array.isArray(await api.tasks("all"))).toBe(true);
    expect(Array.isArray(await api.connections())).toBe(true);
    // Forced refresh rotates the tokens and keeps working.
    const rotated = await sm.refresh();
    expect(rotated?.refresh_token).not.toBe(session.refresh_token);
    expect((await api.me()).id).toBe(session.user.id);

    const matrix = new AgentStudioMatrix({ credentials: session.matrix });
    try {
      await matrix.start();
      expect(matrix.getSyncStatus()).toBe("syncing");

      const demo = (await api.networks()).find((n) => n.id === "demo");
      if (!demo?.available) {
        (globalThis as unknown as { console: { warn(m: string): void } }).console.warn("demo bridge not available; skipping demo portal check");
        return;
      }
      const { process_id, step } = await api.startLogin("demo", "demo");
      let s = step;
      if (s.type === "user_input") s = await api.submitLoginStep(process_id, s.step_id, { fields: { display_name: "Core IT" } });
      expect(s.type).toBe("complete");

      const agents = new AgentsStore(api);
      const inbox = new InboxStore({ matrix, agents });
      const rows = await until(() => {
        const names = inbox.rows.getSnapshot().map((r) => r.name);
        return ["Mom", "Leo Park", "Book Club"].every((n) => names.includes(n)) ? inbox.rows.getSnapshot() : null;
      }, "demo portals in inbox", 30_000);
      expect(rows.every((r) => r.network === "demo" && r.networkLabel === "Demo")).toBe(true);

      const mom = rows.find((r) => r.name === "Mom")!;
      const sent = await matrix.sendText(mom.roomId, "it-ping");
      expect(sent.ok).toBe(true);
      await until(() => matrix.getMessages(mom.roomId).some((m) => m.body === "Echo: it-ping"), "echo reply");
      inbox.dispose();
    } finally {
      matrix.stop();
      await sm.logout();
    }
  }, 90_000);
});
