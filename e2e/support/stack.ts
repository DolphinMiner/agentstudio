// Talking to the local stack directly: generated env, API health, the dev
// outbox (sign-in codes) and the demo bridge's dev hook.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(__dirname, "..", "..");
export const SERVER_URL = process.env.AGENTSTUDIO_SERVER_URL ?? "http://127.0.0.1:18090";

let envCache: Record<string, string> | null = null;

/** Reads .local/env (written by `pnpm dev:up`). Process env wins. */
export function stackEnv(): Record<string, string> {
  if (envCache) return envCache;
  const file = process.env.AGENTSTUDIO_ENV_FILE ?? join(REPO_ROOT, ".local", "env");
  const out: Record<string, string> = {};
  if (existsSync(file)) {
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      let value = line.slice(eq + 1).trim();
      if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
      out[line.slice(0, eq).replace(/^export\s+/, "").trim()] = value;
    }
  }
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k in out) out[k] = v;
  envCache = out;
  return out;
}

export function requireEnv(name: string): string {
  const v = stackEnv()[name];
  if (!v) throw new Error(`${name} is not set; is the stack up (pnpm dev:up)?`);
  return v;
}

export type Health = { ok: boolean; synapse: boolean; bridges: Record<string, boolean> };

export async function health(): Promise<Health | null> {
  try {
    const res = await fetch(`${SERVER_URL}/v1/health`);
    return res.ok ? ((await res.json()) as Health) : null;
  } catch {
    return null;
  }
}

export function healthy(h: Health | null): boolean {
  return !!h && h.ok && h.synapse && Object.keys(h.bridges).length > 0 && Object.values(h.bridges).every(Boolean);
}

/** A unique, lowercase email per test (the API throttles codes per email). */
export function uniqueEmail(tag: string): string {
  const rnd = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `e2e-${tag}-${rnd}@example.com`.toLowerCase();
}

type OutboxMessage = { to: string; code: string; sent_at: string };

export async function outbox(email: string): Promise<OutboxMessage[]> {
  const res = await fetch(`${SERVER_URL}/v1/dev/outbox?email=${encodeURIComponent(email)}`);
  if (!res.ok) throw new Error(`dev outbox: HTTP ${res.status}`);
  return ((await res.json()) as { messages: OutboxMessage[] }).messages;
}

/** Waits for a code newer than the first `seen` messages (the outbox is newest first). */
export async function waitForCode(email: string, seen: number, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msgs = await outbox(email);
    if (msgs.length > seen && msgs[0]?.code) return msgs[0].code;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`no new sign-in code for ${email} in the dev outbox`);
}

export type DemoPortal = "mom" | "leo" | "bookclub";
export type DemoSender = "mom" | "leo" | "mia" | "+15550101";

/** Injects an incoming demo-network message through the demo bridge's dev hook. */
export async function demoIncoming(userMxid: string, portal: DemoPortal, sender: DemoSender, text: string): Promise<string> {
  const base = stackEnv().DEMO_BRIDGE_URL ?? "http://127.0.0.1:18101";
  const res = await fetch(`${base}/agentstudio/dev/v1/incoming`, {
    method: "POST",
    headers: { Authorization: `Bearer ${requireEnv("AGENTSTUDIO_INTERNAL_SECRET")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ user_mxid: userMxid, portal, sender, text }),
  });
  if (res.status !== 202) throw new Error(`demo dev hook: HTTP ${res.status} ${await res.text()}`);
  return ((await res.json()) as { message_id: string }).message_id;
}
