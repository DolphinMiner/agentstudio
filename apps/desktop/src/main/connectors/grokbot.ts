// Grok Bot connector. Grok Bot (SpaceX AI, built by Cursor) has no web UI; its
// desktop app talks Connect RPC (protobuf) to Cursor's backend. We do the same
// with the user's own account, reverse-engineered from Grok Bot 0.78.3:
//
//   sign-in:  {web}/loginDeepControl?challenge=S256(verifier)&uuid&mode=login&redirectTarget=sand
//             in the user's browser, then GET {api}/auth/poll?uuid&verifier -> tokens
//   refresh:  POST {api}/oauth/token {client_id, grant_type: refresh_token, refresh_token}
//   RPC:      POST {api}/aiserver.v1.GrokBotService/<Method> (application/proto)
//             ListGrokBotAgents, SendGrokBotUserMessage, ListGrokBotTranscriptEntries,
//             RespondGrokBotWidget, DismissGrokBotWidget
//
// Transcript entry bodies are not documented; parseEntry() reads them
// defensively. Set AGENTSTUDIO_CONNECTOR_TRACE=1 to record what the live service
// returns, so the parser can be calibrated.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { decode, encode, type ProtoMessage, type Schema } from "./proto";
import { askPrompt, parseDrafts, truncate, HISTORY_ON_CONNECT, MAX_TEXT, type AgentEvent, type AgentInfo, type InboundMessage, type Choice } from "./protocol";
import { UnknownApprovalError, type Connector, type ConnectorState, type Emitter, type Trace } from "./types";

export type GrokConfig = {
  apiUrl: string; // https://api2.cursor.sh
  webUrl: string; // https://cursor.com
  clientId: string;
  clientVersion: string;
  pollActiveMs: number;
  pollIdleMs: number;
  trace?: Trace;
};

export const GROK_DEFAULTS = {
  apiUrl: "https://api2.cursor.sh",
  webUrl: "https://cursor.com",
  clientId: "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB",
  clientVersion: "0.78.3",
};

export type GrokTokens = { accessToken: string; refreshToken: string };
export type GrokAgentRef = {
  id: string;
  name: string;
  description: string;
  sessionId: string;
  /** A photo the owner uploaded. */
  avatarUrl?: string;
  /** Otherwise Grok Bot draws the avatar from a shape and a color (see grokavatar.ts). */
  avatarShape?: string;
  avatarColor?: string;
};
export type GrokData = GrokTokens & { machineId: string; agent: GrokAgentRef; lastSeq?: number };

// ---- protobuf schemas (aiserver.v1, transcribed from the app bundle) --------

const GrokBotAgent: Schema = [
  { no: 1, name: "id", type: "string" },
  { no: 3, name: "name", type: "string" },
  { no: 4, name: "description", type: "string" },
  { no: 5, name: "title", type: "string" },
  { no: 6, name: "avatar_shape", type: "string" },
  { no: 7, name: "avatar_color", type: "string" },
  { no: 9, name: "avatar_url", type: "string" },
  { no: 12, name: "agent_id", type: "string" },
  { no: 14, name: "role", type: "string" },
  { no: 18, name: "viewer_session_id", type: "string" },
];
const ListGrokBotAgentsRequest: Schema = [];
const ListGrokBotAgentsResponse: Schema = [{ no: 1, name: "agents", type: "message", repeated: true, schema: GrokBotAgent }];
const SendGrokBotUserMessageRequest: Schema = [
  { no: 1, name: "agent_id", type: "string" },
  { no: 2, name: "message_id", type: "string" },
  { no: 3, name: "text", type: "string" },
  { no: 4, name: "sent_at_ms", type: "int64" },
  { no: 12, name: "composed_at_ms", type: "int64" },
  { no: 15, name: "session_id", type: "string" },
  { no: 20, name: "language", type: "string" },
];
const SendGrokBotUserMessageResponse: Schema = [
  { no: 1, name: "dispatched", type: "bool" },
  { no: 3, name: "workflow_id", type: "string" },
];
const GrokBotTranscriptEntry: Schema = [
  { no: 1, name: "seq", type: "int64" },
  { no: 2, name: "entry_kind", type: "string" },
  { no: 3, name: "body", type: "bytes" },
  { no: 4, name: "blob_hash", type: "string" },
  { no: 5, name: "updated_seq", type: "int64" },
  { no: 6, name: "entry_id", type: "string" },
  { no: 7, name: "body_omitted", type: "bool" },
];
const ListGrokBotTranscriptEntriesRequest: Schema = [
  { no: 1, name: "agent_id", type: "string" },
  { no: 3, name: "before_seq", type: "int64" },
  { no: 4, name: "limit", type: "uint32" },
  { no: 5, name: "session_id", type: "string" },
];
const ListGrokBotTranscriptEntriesResponse: Schema = [
  { no: 1, name: "entries", type: "message", repeated: true, schema: GrokBotTranscriptEntry },
  { no: 2, name: "generation", type: "uint32" },
];
const WidgetRequest: Schema = [
  { no: 1, name: "agent_id", type: "string" },
  { no: 2, name: "entry_id", type: "string" },
  { no: 3, name: "value", type: "string" },
  { no: 4, name: "session_id", type: "string" },
];
const DismissWidgetRequest: Schema = [
  { no: 1, name: "agent_id", type: "string" },
  { no: 2, name: "entry_id", type: "string" },
  { no: 3, name: "session_id", type: "string" },
];
const RespondWidgetResponse: Schema = [{ no: 1, name: "accepted", type: "bool" }];

// ---- HTTP plumbing ------------------------------------------------------------

/** Grok Bot's x-cursor-checksum: an obfuscated coarse timestamp followed by the machine id. */
export function cursorChecksum(machineId: string, now = Date.now()): string {
  const t = Math.floor(now / 1e6);
  const b = Uint8Array.from([(t / 2 ** 40) & 255, (t / 2 ** 32) & 255, (t >>> 24) & 255, (t >>> 16) & 255, (t >>> 8) & 255, t & 255]);
  let k = 165;
  for (let i = 0; i < b.length; i++) {
    b[i] = ((b[i]! ^ k) + (i % 256)) & 255;
    k = b[i]!;
  }
  return Buffer.from(b).toString("base64url") + machineId;
}

function clientHeaders(cfg: GrokConfig, machineId: string): Record<string, string> {
  return {
    "user-agent": `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) GrokBot/${cfg.clientVersion} Safari/537.36`,
    "x-cursor-client-type": "sand",
    "x-cursor-client-version": cfg.clientVersion,
    "x-cursor-client-os": "darwin",
    "x-sand-box-namespace": "prod",
    "x-ghost-mode": "true",
    "x-cursor-checksum": cursorChecksum(machineId),
    "x-request-id": randomUUID(),
  };
}

export class GrokAuthError extends Error {}

/**
 * One Grok Bot account. Every bot of the account shares one client, so a token
 * refresh (which rotates the refresh token) happens once for all of them.
 */
export class GrokClient {
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly cfg: GrokConfig,
    private tokens: GrokTokens,
    readonly machineId: string,
    private readonly onTokens: (t: GrokTokens) => void,
  ) {}

  get currentTokens(): GrokTokens {
    return this.tokens;
  }

  async rpc(method: string, reqSchema: Schema, req: ProtoMessage, resSchema: Schema): Promise<ProtoMessage> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const usedToken = this.tokens.accessToken;
      const res = await fetch(`${this.cfg.apiUrl}/aiserver.v1.GrokBotService/${method}`, {
        method: "POST",
        headers: {
          ...clientHeaders(this.cfg, this.machineId),
          "content-type": "application/proto",
          "connect-protocol-version": "1",
          authorization: `Bearer ${this.tokens.accessToken}`,
        },
        body: encode(reqSchema, req),
        signal: AbortSignal.timeout(30_000),
      });
      const buf = new Uint8Array(await res.arrayBuffer());
      this.cfg.trace?.("grokbot.rpc", { method, status: res.status, bytes: buf.length });
      if (res.status === 401 && attempt === 0) {
        // Another bot may already have refreshed while this call was in flight.
        if (this.tokens.accessToken === usedToken) await this.refresh();
        continue;
      }
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const e = JSON.parse(new TextDecoder().decode(buf)) as { code?: string; message?: string };
          msg = e.message || e.code || msg;
        } catch {
          /* not JSON */
        }
        if (res.status === 401 || res.status === 403) throw new GrokAuthError(`Grok Bot sign-in expired (${msg})`);
        throw new Error(`Grok Bot ${method}: ${msg}`);
      }
      return decode(resSchema, buf);
    }
    throw new GrokAuthError("Grok Bot sign-in expired");
  }

  private refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh() {
    const res = await fetch(`${this.cfg.apiUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", ...clientHeaders(this.cfg, this.machineId) },
      body: JSON.stringify({ client_id: this.cfg.clientId, grant_type: "refresh_token", refresh_token: this.tokens.refreshToken }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; shouldLogout?: boolean };
    if (!res.ok || !body.access_token || body.shouldLogout) throw new GrokAuthError("Grok Bot sign-in expired; connect it again");
    this.tokens = { accessToken: body.access_token, refreshToken: body.refresh_token || this.tokens.refreshToken };
    this.onTokens(this.tokens);
  }

  async listAgents(): Promise<GrokAgentRef[]> {
    const res = await this.rpc("ListGrokBotAgents", ListGrokBotAgentsRequest, {}, ListGrokBotAgentsResponse);
    return ((res.agents as ProtoMessage[] | undefined) ?? []).map((a) => ({
      // agent_id is the bot's id (Grok Bot uses it everywhere); `id` is a server id that isn't unique per bot.
      id: String(a.agent_id || a.id || ""),
      name: String(a.name || a.title || "Grok Bot"),
      description: String(a.description || ""),
      sessionId: String(a.viewer_session_id || ""),
      // https only (loopback http for local test fakes).
      avatarUrl: typeof a.avatar_url === "string" && /^(https:\/\/|http:\/\/127\.0\.0\.1[:/])/.test(a.avatar_url) ? a.avatar_url : undefined,
      avatarShape: a.avatar_shape ? String(a.avatar_shape) : undefined,
      avatarColor: a.avatar_color ? String(a.avatar_color) : undefined,
    })).filter((a) => a.id);
  }
}

// ---- sign-in ------------------------------------------------------------------

export type GrokLoginResult = { tokens: GrokTokens; machineId: string; agents: GrokAgentRef[] };

/**
 * Runs the browser sign-in: opens the login page, then polls until the user
 * finishes (up to ~10 minutes) or the signal aborts.
 */
export async function grokLogin(
  cfg: GrokConfig,
  openExternal: (url: string) => void | Promise<void>,
  signal: AbortSignal,
): Promise<GrokLoginResult> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const uuid = randomUUID();
  // String joins (not new URL("/x", base)) keep any path prefix in the configured base.
  const login = new URL(`${cfg.webUrl}/loginDeepControl`);
  login.searchParams.set("challenge", challenge);
  login.searchParams.set("uuid", uuid);
  login.searchParams.set("mode", "login");
  login.searchParams.set("redirectTarget", "sand");
  await openExternal(login.toString());

  const machineId = createHash("sha256").update(randomBytes(32)).digest("hex");
  const poll = new URL(`${cfg.apiUrl}/auth/poll`);
  poll.searchParams.set("uuid", uuid);
  poll.searchParams.set("verifier", verifier);
  let delay = 1000;
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("cancelled");
    try {
      const res = await fetch(poll, { headers: { "content-type": "application/json", ...clientHeaders(cfg, machineId) }, signal });
      if (res.ok) {
        const body = (await res.json()) as Record<string, unknown>;
        const accessToken = String(body.accessToken ?? body.xaiAccessToken ?? "");
        const refreshToken = String(body.refreshToken ?? body.xaiRefreshToken ?? "");
        if (!accessToken) throw new Error("Grok Bot sign-in returned no token");
        const tokens = { accessToken, refreshToken };
        const agents = await new GrokClient(cfg, tokens, machineId, () => {}).listAgents();
        if (agents.length === 0) throw new Error("This account has no Grok Bot yet. Create one in the Grok Bot app first.");
        return { tokens, machineId, agents };
      }
      if (res.status !== 404) cfg.trace?.("grokbot.poll", { status: res.status });
    } catch (err) {
      if (signal.aborted) throw new Error("cancelled");
      if (err instanceof Error && !/fetch failed|network/i.test(err.message)) throw err;
    }
    await sleep(delay, signal);
    delay = Math.min(delay * 1.2, 5000);
  }
  throw new Error("Sign-in timed out. Try again.");
}

// ---- transcript parsing --------------------------------------------------------

export type ParsedEntry = (
  | { kind: "assistant"; text: string }
  /** nonce: the message_id AgentStudio sent it with, when AgentStudio sent it. */
  | { kind: "user"; text: string; nonce?: string }
  /** Something AgentStudio can't show (a file, a chart, a call): a note pointing to Grok Bot. */
  | { kind: "notice"; text: string }
  | { kind: "widget"; prompt: string; options: { value: string; label: string }[] }
  | { kind: "other" }
) & {
  /** When it was sent (body timestampMs), if known. */
  ts?: number;
};

/** Reads a transcript entry body. Bodies are JSON in every build we have seen; be lenient. */
export function parseEntry(entryKind: string, body: Uint8Array | undefined): ParsedEntry {
  return parseEntryBody(entryKind, body);
}

function parseEntryBody(entryKind: string, body: Uint8Array | undefined): ParsedEntry {
  if (!body || body.length === 0) return { kind: "other" };
  const raw = new TextDecoder().decode(body);
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    const lines = raw.split("\n").filter(Boolean);
    try {
      obj = lines.length > 1 ? JSON.parse(lines[lines.length - 1]!) : undefined;
    } catch {
      obj = undefined;
    }
  }
  if (!obj || typeof obj !== "object") {
    return /assistant|agent|bot/i.test(entryKind) && raw.trim() ? { kind: "assistant", text: raw.trim() } : { kind: "other" };
  }
  const o = obj as Record<string, unknown>;
  const kind = String(o.kind ?? o.type ?? entryKind ?? "");
  const ts = typeof o.timestampMs === "number" && o.timestampMs > 0 ? o.timestampMs : undefined;
  const withTs = (p: ParsedEntry): ParsedEntry => (ts === undefined || p.kind === "other" ? p : { ...p, ts });
  return withTs(parseObject(o, kind, entryKind));
}

function parseObject(o: Record<string, unknown>, kind: string, entryKind: string): ParsedEntry {
  // A card Grok Bot shows in the chat: {kind: "send-message", message: {type: "widget", widget: {prompt, options}}}.
  const sent = o.message && typeof o.message === "object" ? (o.message as Record<string, unknown>) : undefined;
  if (sent?.type === "widget" && sent.widget && typeof sent.widget === "object") {
    // Already answered or skipped in Grok Bot: nothing to ask.
    if (o.widgetSkipped === true || o.widgetAnswered === true || o.answer !== undefined) return { kind: "other" };
    const w = sent.widget as Record<string, unknown>;
    const prompt = textOf(w.prompt) || textOf(w.title) || "Grok Bot needs your answer";
    const opts = optionsOf(w);
    return opts.length > 0 ? { kind: "widget", prompt, options: opts } : { kind: "assistant", text: prompt };
  }
  // Grok Bot's own kinds that aren't chat (tool runs, status, ratings) stay out.
  if (INTERNAL_KINDS.has(kind) || INTERNAL_KINDS.has(entryKind)) return { kind: "other" };
  const name = textOf(sent?.name) || textOf(sent?.fileName) || textOf(sent?.filename) || textOf((sent?.attachment as Record<string, unknown> | undefined)?.name);
  if (sent?.type === "local-tool-permission") {
    // Grok Bot asking to use this Mac (run a command, read files). Answered in Grok Bot; once
    // decided ("once", "always", "denied", "expired") there's nothing to show.
    const ask = (sent.ask ?? {}) as Record<string, unknown>;
    const status = String(ask.status ?? "pending");
    if (status !== "pending") return { kind: "other" };
    const action = textOf(ask.action);
    return { kind: "notice", text: `🔐 Grok Bot is asking to ${action || "use your computer"}. Answer it in Grok Bot.` };
  }
  if (sent?.type === "attachment") return { kind: "notice", text: `📎 Grok Bot sent a file${name ? ` (${name})` : ""}. Open Grok Bot to see it.` };
  if (sent?.type === "visualization") return { kind: "notice", text: "📊 Grok Bot sent a chart. Open Grok Bot to see it." };
  if (kind === "voice-call") return { kind: "notice", text: "📞 There was a call with Grok Bot. Open Grok Bot to see it." };
  if (kind === "mcp-app") return { kind: "notice", text: "Grok Bot opened an app. Open Grok Bot to use it." };
  if (kind === "user-attachment") return { kind: "user", text: `📎 Sent a file${name ? ` (${name})` : ""}` };
  const options = optionsOf(o);
  if (/widget/i.test(kind) || /widget/i.test(entryKind)) {
    if (options.length > 0) return { kind: "widget", prompt: textOf(o.prompt) || textOf(o) || "Grok Bot needs your answer", options };
    return { kind: "other" };
  }
  const msg = (o.message && typeof o.message === "object" ? o.message : o) as Record<string, unknown>;
  const role = String(o.role ?? msg.role ?? (o.author as Record<string, unknown> | undefined)?.role ?? "");
  const text = textOf(msg.content) || textOf(msg.text) || textOf(o.content) || textOf(o.text);
  if (!text) {
    // A kind we don't know yet: say so rather than lose it.
    return KNOWN_KINDS.has(kind) ? { kind: "other" } : { kind: "notice", text: "Grok Bot sent something AgentStudio can't show yet. Open Grok Bot to see it." };
  }
  if (role === "user" || kind === "user-message") {
    const nonce = typeof o.clientNonce === "string" ? o.clientNonce : undefined;
    return nonce ? { kind: "user", text, nonce } : { kind: "user", text };
  }
  if (role === "assistant" || role === "agent" || kind === "send-message" || /assistant|agent/i.test(kind) || /assistant|agent/i.test(entryKind)) {
    if (o.isStreaming === true || o.streaming === true) return { kind: "other" };
    return { kind: "assistant", text };
  }
  return { kind: "other" };
}

/** Transcript kinds the Grok Bot app has (0.78.3); the internal ones aren't chat. */
const KNOWN_KINDS = new Set(["message", "tool-call", "send-message", "user-attachment", "notice", "event", "feedback", "voice-call", "mcp-app", "user-message"]);
const INTERNAL_KINDS = new Set(["tool-call", "notice", "event", "feedback"]);

function textOf(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join("\n").trim();
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return o.text.trim();
    if (typeof o.content === "string") return o.content.trim();
    if (Array.isArray(o.parts)) return textOf(o.parts);
  }
  return "";
}

function optionsOf(o: Record<string, unknown>): { value: string; label: string }[] {
  const src = (o.options ?? o.choices ?? (o.widget as Record<string, unknown> | undefined)?.options) as unknown;
  if (!Array.isArray(src)) return [];
  return src
    .map((x) => {
      if (typeof x === "string") return { value: x, label: x };
      if (x && typeof x === "object") {
        const r = x as Record<string, unknown>;
        const label = String(r.label ?? r.text ?? r.title ?? r.value ?? "");
        return { value: String(r.value ?? r.id ?? label), label };
      }
      return null;
    })
    .filter((x): x is { value: string; label: string } => !!x && !!x.label)
    .slice(0, 4);
}

const DENY_WORDS = /^(no|don'?t|do not|deny|reject|decline|cancel|skip|not now|stop|never)\b/i;

/** Maps widget options to approval choices; adds a "Dismiss" when nothing reads as a no. */
export function widgetChoices(options: { value: string; label: string }[]): Choice[] {
  const choices: Choice[] = options.map((o) => ({
    key: o.value.slice(0, 200),
    label: truncate(o.label, 80),
    category: DENY_WORDS.test(o.label) ? "deny" : "approve",
  }));
  if (!choices.some((c) => c.category === "deny")) {
    if (choices.length >= 4) choices.length = 3;
    choices.push({ key: DISMISS, label: "Dismiss", category: "deny" });
  }
  if (!choices.some((c) => c.category === "approve")) choices[0]!.category = "approve";
  return choices;
}

const DISMISS = "__agentstudio_dismiss";

/** The last chat entries of a transcript, as history (oldest first). */
export function grokHistory(entries: ProtoMessage[], max = HISTORY_ON_CONNECT): Extract<AgentEvent, { type: "message" }>[] {
  const out: Extract<AgentEvent, { type: "message" }>[] = [];
  for (const e of [...entries].sort((a, b) => Number(a.seq) - Number(b.seq))) {
    const p = parseEntry(String(e.entry_kind ?? ""), e.body as Uint8Array | undefined);
    const ts = p.ts ? { ts: new Date(p.ts).toISOString() } : {};
    if (p.kind === "assistant" || p.kind === "notice") out.push({ type: "message", text: truncate(p.text, MAX_TEXT), history: true, ...ts });
    else if (p.kind === "user") out.push({ type: "message", text: truncate(p.text, MAX_TEXT), from_user: true, via: "Grok Bot", history: true, ...ts });
  }
  return out.slice(-max);
}

// ---- the connector ----------------------------------------------------------------

export class GrokBotConnector implements Connector {
  private emitter: Emitter | null = null;
  private running = false;
  private status: ConnectorState = { status: "starting" };
  private activeUntil = 0;
  private ownMessageIds = new Set<string>();
  /** Texts AgentStudio sent, so their transcript entries aren't shown twice. */
  private ownTexts = new Set<string>();
  private seen = new Map<string, number>(); // entry id -> updated_seq emitted or pending
  private pending = new Map<string, { updated: number; polls: number; text: string }>();
  private pendingAsk: string | null = null;
  private widgets = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  private avatarCache: { mime: string; data: Buffer } | null = null;

  constructor(
    private readonly cfg: GrokConfig,
    private data: GrokData,
    private readonly client: GrokClient,
    private readonly onChange: () => void,
    /** The avatar Grok Bot draws for the bot (its shape and color), else the app icon. */
    private readonly drawnAvatar: (agent: GrokAgentRef) => Promise<{ mime: string; data: Buffer } | null>,
  ) {}

  /** The bot's own avatar: its photo, or the one Grok Bot draws for it. */
  async avatar(): Promise<{ mime: string; data: Buffer } | null> {
    if (this.avatarCache) return this.avatarCache;
    const url = this.data.agent.avatarUrl;
    if (url) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        const mime = res.headers.get("content-type") ?? "";
        if (res.ok && mime.startsWith("image/")) {
          this.avatarCache = { mime, data: Buffer.from(await res.arrayBuffer()) };
          return this.avatarCache;
        }
      } catch {
        /* fall back to the drawn avatar */
      }
    }
    this.avatarCache = await this.drawnAvatar(this.data.agent);
    return this.avatarCache;
  }

  info(): AgentInfo {
    return {
      name: this.data.agent.name || "Grok Bot",
      description: this.data.agent.description || "Your Grok Bot, through your own account.",
      capabilities: ["chat", "ask", "approvals"],
      protocol: "agentstudio-agent/0",
    };
  }

  state(): ConnectorState {
    return this.status;
  }

  serialize(): unknown {
    // Tokens live in the shared account client; keep the latest ones.
    return { ...this.data, ...this.client.currentTokens };
  }

  async start(emitter: Emitter): Promise<void> {
    this.emitter = emitter;
    this.running = true;
    try {
      await this.refreshProfile();
      if (this.data.lastSeq === undefined) {
        // Earlier entries are history: the last few come over as such, the rest stays in Grok Bot.
        const entries = await this.list();
        for (const m of grokHistory(entries)) emitter.emit(m);
        this.data.lastSeq = Math.max(0, ...entries.map((e) => Number(e.seq ?? 0)));
        for (const e of entries) this.seen.set(String(e.entry_id ?? e.seq), Number(e.updated_seq ?? 0));
        this.onChange();
      }
      this.status = { status: "ready" };
    } catch (err) {
      this.status = { status: err instanceof GrokAuthError ? "needs_login" : "error", message: String((err as Error).message) };
    }
    this.schedule(0);
  }

  /**
   * Picks up a new name or avatar the owner set in Grok Bot. Also repairs bots
   * saved under the wrong id (before 0.1 read agent_id): matched by name, they
   * move to their real id and start fresh from now.
   */
  private async refreshProfile() {
    const list = await this.client.listAgents().catch(() => null);
    if (!list) return;
    const cur = this.data.agent;
    const fresh = (cur.id ? list.find((a) => a.id === cur.id) : undefined) ?? list.find((a) => a.name === cur.name);
    if (!fresh) return;
    const moved = fresh.id !== cur.id;
    const changed = moved || (["name", "avatarUrl", "avatarShape", "avatarColor"] as const).some((k) => fresh[k] !== cur[k]);
    if (!changed) return;
    this.data.agent = { ...cur, ...fresh, sessionId: fresh.sessionId || cur.sessionId };
    if (moved) {
      this.cfg.trace?.("grokbot.repair", { name: fresh.name });
      this.data.lastSeq = undefined;
      this.seen.clear();
      this.pending.clear();
    }
    this.avatarCache = null;
    this.onChange();
    this.emitter?.profileChanged();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  async send(msg: InboundMessage): Promise<void> {
    const text = msg.ask ? askPrompt(msg.ask) : msg.text;
    const id = randomUUID();
    this.ownMessageIds.add(id);
    this.ownTexts.add(text.trim());
    if (msg.ask) this.pendingAsk = msg.ask.task_id;
    const now = Date.now();
    const res = await this.client.rpc(
      "SendGrokBotUserMessage",
      SendGrokBotUserMessageRequest,
      { agent_id: this.data.agent.id, message_id: id, text, sent_at_ms: now, composed_at_ms: now, session_id: this.data.agent.sessionId, language: "en" },
      SendGrokBotUserMessageResponse,
    );
    this.cfg.trace?.("grokbot.send", { dispatched: res.dispatched });
    this.emitter?.emit({ type: "status", state: "working", text: "Working" });
    this.activeUntil = Date.now() + 10 * 60_000;
    this.schedule(this.cfg.pollActiveMs);
  }

  async decide(externalId: string, choice: string): Promise<void> {
    if (!this.widgets.has(externalId)) throw new UnknownApprovalError();
    this.widgets.delete(externalId);
    const base = { agent_id: this.data.agent.id, entry_id: externalId, session_id: this.data.agent.sessionId };
    if (choice === DISMISS) {
      await this.client.rpc("DismissGrokBotWidget", DismissWidgetRequest, base, []);
    } else {
      this.ownTexts.add(choice.trim()); // Grok Bot may log the answer as the user's message
      const res = await this.client.rpc("RespondGrokBotWidget", WidgetRequest, { ...base, value: choice }, RespondWidgetResponse);
      if (res.accepted === false) throw new Error("Grok Bot didn't accept the answer");
    }
    this.activeUntil = Date.now() + 10 * 60_000;
    this.schedule(this.cfg.pollActiveMs);
  }

  private schedule(ms: number) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async list(): Promise<ProtoMessage[]> {
    const res = await this.client.rpc(
      "ListGrokBotTranscriptEntries",
      ListGrokBotTranscriptEntriesRequest,
      { agent_id: this.data.agent.id, limit: 50, session_id: this.data.agent.sessionId },
      ListGrokBotTranscriptEntriesResponse,
    );
    return ((res.entries as ProtoMessage[] | undefined) ?? []).sort((a, b) => Number(a.seq) - Number(b.seq));
  }

  private async tick() {
    if (!this.running) return;
    try {
      const entries = await this.list();
      this.status = { status: "ready" };
      this.process(entries);
    } catch (err) {
      this.status = { status: err instanceof GrokAuthError ? "needs_login" : "error", message: String((err as Error).message) };
      this.cfg.trace?.("grokbot.poll_error", { message: this.status.message });
    }
    this.schedule(Date.now() < this.activeUntil ? this.cfg.pollActiveMs : this.cfg.pollIdleMs);
  }

  private process(entries: ProtoMessage[]) {
    const emit = (e: Parameters<Emitter["emit"]>[0]) => this.emitter?.emit(e);
    const latestSeq = Math.max(0, ...entries.map((e) => Number(e.seq ?? 0)));
    for (const e of entries) {
      const id = String(e.entry_id || e.seq);
      const updated = Number(e.updated_seq ?? 0);
      const seq = Number(e.seq ?? 0);
      if (seq <= (this.data.lastSeq ?? 0) && !this.pending.has(id)) continue;
      if ((this.seen.get(id) ?? -1) >= updated && !this.pending.has(id)) continue;
      const parsed = parseEntry(String(e.entry_kind ?? ""), e.body as Uint8Array | undefined);
      this.cfg.trace?.("grokbot.entry", {
        seq, kind: e.entry_kind, omitted: e.body_omitted, blob: !!e.blob_hash,
        parsed: parsed.kind, body: process.env.AGENTSTUDIO_CONNECTOR_TRACE_BODIES === "1" && e.body ? new TextDecoder().decode(e.body as Uint8Array).slice(0, 4000) : undefined,
      });
      if (parsed.kind === "widget") {
        this.seen.set(id, updated);
        if (!this.widgets.has(id)) {
          this.widgets.add(id);
          emit({ type: "approval_request", external_id: id, title: truncate(parsed.prompt, 300), choices: widgetChoices(parsed.options) });
        }
        continue;
      }
      if (parsed.kind === "user") {
        this.seen.set(id, updated);
        // What the user typed in Grok Bot itself (AgentStudio's own sends are skipped).
        const ours = (parsed.nonce && this.ownMessageIds.delete(parsed.nonce)) || this.ownTexts.delete(parsed.text);
        if (!ours) emit({ type: "message", text: truncate(parsed.text, MAX_TEXT), from_user: true, via: "Grok Bot" });
        continue;
      }
      if (parsed.kind === "notice") {
        this.seen.set(id, updated);
        emit({ type: "message", text: parsed.text });
        continue;
      }
      if (parsed.kind !== "assistant") {
        this.seen.set(id, updated);
        continue;
      }
      // Assistant entries can stream; emit once the text stops changing (or a later entry exists).
      const p = this.pending.get(id);
      const stable = p && p.updated === updated && p.text === parsed.text;
      if (!stable && seq >= latestSeq && (p?.polls ?? 0) < 30) {
        this.pending.set(id, { updated, polls: (p?.polls ?? 0) + 1, text: parsed.text });
        continue;
      }
      this.pending.delete(id);
      this.seen.set(id, updated);
      if (this.pendingAsk) {
        const taskId = this.pendingAsk;
        this.pendingAsk = null;
        emit({ type: "drafts", task_id: taskId, drafts: parseDrafts(parsed.text).map((text) => ({ text })) });
      } else {
        emit({ type: "message", text: truncate(parsed.text, MAX_TEXT) });
      }
      emit({ type: "status", state: "idle" });
    }
    const maxDone = Math.max(this.data.lastSeq ?? 0, ...entries.filter((e) => !this.pending.has(String(e.entry_id || e.seq))).map((e) => Number(e.seq ?? 0)));
    if (maxDone !== this.data.lastSeq) {
      this.data.lastSeq = maxDone;
      this.onChange();
    }
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
