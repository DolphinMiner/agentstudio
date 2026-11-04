// Serves the agent side of the AgentStudio Agent Protocol for every connector
// instance on this Mac, on 127.0.0.1 only:
//
//   {base}/c/{instanceId}/agentstudio/v0/info | sessions | messages | approvals/{id}/decision
//
// Each instance has its own bearer token, which the agents bridge stores as the
// agent token when the user connects it. Callbacks to the bridge are queued per
// instance so they arrive in order.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AgentEvent, InboundMessage } from "./protocol";
import { PROTOCOL_VERSION } from "./protocol";
import type { BridgeSession as Session } from "./store";
import { UnknownApprovalError, type Connector, type Emitter } from "./types";

export type HostedInstance = {
  id: string;
  token: string;
  connector: Connector;
  /** The bridge's session from before a restart: callbacks go out at once, without waiting for the bridge to come back. */
  session?: Session;
};

const MAX_BODY = 1 << 20;

/** Events kept per instance until the bridge connects. */
const MAX_HELD = 100;

export class ConnectorHost {
  private server: Server | null = null;
  private readonly instances = new Map<string, HostedInstance & { session?: Session; held?: AgentEvent[]; queue: Promise<void>; jobs: Promise<void> }>();

  /** port 0 picks a free port (tests); real use keeps a fixed port, since the bridge stores the URL. */
  constructor(
    private port: number,
    private readonly log: (msg: string, extra?: Record<string, unknown>) => void = () => {},
    /** Called when the bridge opens or closes an instance's session (to keep it across restarts). */
    private readonly onSession: (id: string, session: Session | undefined) => void = () => {},
  ) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  urlFor(id: string): string {
    return `${this.baseUrl}/c/${id}`;
  }

  async listen(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.log("connector request failed", { err: String(err) });
        if (!res.headersSent) json(res, 500, { error: { code: "internal", message: "internal error" } });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (addr && typeof addr === "object") this.port = addr.port;
    this.server = server;
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  /** Adds an instance and returns the emitter its connector should use. */
  add(inst: HostedInstance): Emitter {
    const entry = { ...inst, queue: Promise.resolve(), jobs: Promise.resolve() } as HostedInstance & {
      session?: Session;
      /** Events from before the bridge connected (history on connect, a profile change); sent once it does. */
      held?: AgentEvent[];
      queue: Promise<void>;
      jobs: Promise<void>;
    };
    this.instances.set(inst.id, entry);
    const emit = (evt: AgentEvent) => {
      entry.queue = entry.queue.then(() => this.deliver(entry, evt)).catch(() => {});
    };
    return {
      emit,
      profileChanged: () => this.sendProfile(inst.id),
    };
  }

  /** Sends the instance's current name and avatar (the avatar URL changes with the image). */
  sendProfile(id: string) {
    const entry = this.instances.get(id);
    if (!entry) return;
    void this.avatarUrl(id).then((avatar_url) => {
      const name = entry.connector.info().name;
      if (avatar_url || name) entry.queue = entry.queue.then(() => this.deliver(entry, { type: "profile", name, ...(avatar_url ? { avatar_url } : {}) })).catch(() => {});
    });
  }

  remove(id: string) {
    this.instances.delete(id);
  }

  /** URL of the instance's current avatar; the version changes with the image, so the bridge re-fetches it. */
  private async avatarUrl(id: string): Promise<string | undefined> {
    const entry = this.instances.get(id);
    const img = await entry?.connector.avatar?.().catch(() => null);
    if (!img) return undefined;
    const v = createHash("sha256").update(img.data).digest("hex").slice(0, 16);
    return `${this.urlFor(id)}/agentstudio/v0/avatar?v=${v}`;
  }

  private async deliver(entry: { id: string; session?: Session; held?: AgentEvent[] }, evt: AgentEvent) {
    const s = entry.session;
    if (!s) {
      // The bridge connects right after a sign-in finishes; keep what comes first.
      const held = (entry.held ??= []);
      if (evt.type === "profile") entry.held = held.filter((e) => e.type !== "profile");
      if (held.length >= MAX_HELD) {
        this.log("dropping event: no bridge session yet", { instance: entry.id, type: evt.type });
        return;
      }
      entry.held.push(evt);
      return;
    }
    // The bridge registers its callback just after it opens the session (and after
    // the login completes, for a new agent): until then it answers 401/404. Wait for it.
    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        const res = await fetch(`${s.callbackUrl.replace(/\/+$/, "")}/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.callbackToken}` },
          body: JSON.stringify(evt),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return;
        if (res.status < 500 && res.status !== 401 && res.status !== 404) {
          this.log("bridge rejected event", { instance: entry.id, type: evt.type, status: res.status });
          return;
        }
      } catch (err) {
        this.log("callback failed", { instance: entry.id, err: String(err) });
      }
      await new Promise((r) => setTimeout(r, attempt * 500));
    }
    this.log("giving up on event", { instance: entry.id, type: evt.type });
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") return json(res, 200, { ok: true });
    const m = /^\/c\/([A-Za-z0-9_-]{1,64})\/agentstudio\/v0\/(.+)$/.exec(url.pathname);
    const entry = m ? this.instances.get(m[1]!) : undefined;
    if (!m || !entry) return json(res, 404, { error: { code: "not_found", message: "unknown agent" } });
    const route = m[2]!;
    const method = req.method ?? "GET";
    // The avatar is fetched by the bridge without a token; ids are random and the host is loopback-only.
    if (method === "GET" && route === "avatar") {
      const img = await entry.connector.avatar?.().catch(() => null);
      if (!img) return json(res, 404, { error: { code: "not_found", message: "no avatar" } });
      res.writeHead(200, { "Content-Type": img.mime, "Cache-Control": "no-store" });
      res.end(img.data);
      return;
    }
    if (!tokenMatches(req.headers.authorization, entry.token)) {
      return json(res, 401, { error: { code: "unauthenticated", message: "bad token" } });
    }

    if (method === "GET" && route === "info") {
      const avatar_url = await this.avatarUrl(entry.id);
      return json(res, 200, { ...entry.connector.info(), ...(avatar_url ? { avatar_url } : {}), protocol: PROTOCOL_VERSION });
    }
    if (method === "POST" && route === "sessions") {
      const body = (await readJSON(req)) as { callback_url?: string; callback_token?: string; session_id?: string };
      if (!body?.callback_url || !body.callback_token) {
        return json(res, 400, { error: { code: "bad_request", message: "callback_url and callback_token are required" } });
      }
      const id = typeof body.session_id === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(body.session_id)
        ? body.session_id
        : "ses_" + randomBytes(12).toString("hex");
      entry.session = { id, callbackUrl: body.callback_url, callbackToken: body.callback_token };
      this.onSession(entry.id, entry.session);
      json(res, 200, { session_id: id });
      const held = entry.held ?? [];
      entry.held = undefined;
      for (const evt of held) entry.queue = entry.queue.then(() => this.deliver(entry, evt)).catch(() => {});
      // The bridge keeps the avatar it fetched last time; the picture may have changed
      // since (for Grok bots it's drawn on this Mac), so send the current one.
      if (!held.some((e) => e.type === "profile")) this.sendProfile(m[1]!);
      return;
    }
    const del = /^sessions\/(.+)$/.exec(route);
    if (method === "DELETE" && del) {
      if (entry.session?.id === del[1]) {
        entry.session = undefined;
        this.onSession(entry.id, undefined);
      }
      res.writeHead(204).end();
      return;
    }
    if (method === "POST" && route === "messages") {
      const msg = (await readJSON(req)) as InboundMessage;
      if (!msg?.session_id || !msg.message_id || entry.session?.id !== msg.session_id) {
        return json(res, 404, { error: { code: "not_found", message: "unknown session" } });
      }
      // Answer at once; the connector works in order, in the background.
      entry.jobs = entry.jobs
        .then(() => entry.connector.send(msg))
        .catch((err: unknown) => {
          const text = err instanceof Error ? err.message : String(err);
          this.log("connector send failed", { instance: entry.id, err: text });
          entry.queue = entry.queue.then(() => this.deliver(entry, { type: "message", text: `⚠️ ${text}` })).catch(() => {});
        });
      return json(res, 202, {});
    }
    const dec = /^approvals\/([^/]+)\/decision$/.exec(route);
    if (method === "POST" && dec) {
      if (entry.session?.id !== req.headers["x-agentstudio-session"]) {
        return json(res, 404, { error: { code: "not_found", message: "unknown session" } });
      }
      const body = (await readJSON(req)) as { choice?: string };
      if (!body?.choice) return json(res, 400, { error: { code: "bad_request", message: "choice is required" } });
      try {
        await entry.connector.decide(decodeURIComponent(dec[1]!), body.choice);
        return json(res, 200, {});
      } catch (err) {
        if (err instanceof UnknownApprovalError) return json(res, 404, { error: { code: "not_found", message: "unknown approval" } });
        return json(res, 502, { error: { code: "upstream_error", message: err instanceof Error ? err.message : String(err) } });
      }
    }
    return json(res, 404, { error: { code: "not_found", message: "not found" } });
  }
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function tokenMatches(header: string | undefined, want: string): boolean {
  const got = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJSON(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}
