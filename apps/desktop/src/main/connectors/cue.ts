// Cue (cue.im, by Manus): personal agents, each with its own email, phone,
// wallet and computer. Cue has no web app, but Manus publishes an API that
// covers Cue's agents (https://open.manus.ai/docs/v2/agents-overview), so this
// connector uses it with an API key the user creates in Manus settings. Each
// agent has a main task, its conversation; AgentStudio reads it with
// task.listMessages and talks with task.sendMessage / task.confirmAction.

import { createHash } from "node:crypto";
import { askPrompt, parseDrafts, truncate, HISTORY_ON_CONNECT, MAX_TEXT, type AgentEvent, type AgentInfo, type Attachment, type Choice, type InboundMessage } from "./protocol";
import { UnknownApprovalError, type AvatarImage, type Connector, type ConnectorState, type Emitter, type Trace } from "./types";

export const CUE_DEFAULTS = {
  apiUrl: "https://api.manus.ai",
  /** Where the user creates an API key. */
  settingsUrl: "https://manus.im/app#settings/developers",
  /** Sign-in pages, and Manus's own API (used once, to create the key). */
  webUrl: "https://manus.im",
  rpcUrl: "https://api.manus.im",
};

export type CueConfig = {
  apiUrl: string;
  pollActiveMs: number;
  pollIdleMs: number;
  /** task.listMessages allows 100 requests a minute per user; stay under it across all agents. */
  listBudgetPerMinute: number;
  trace?: Trace;
};

export type CueAgentRef = { id: string; taskId: string; name: string; about: string };
export type CueData = { apiKey: string; agent: CueAgentRef; since?: number };

export class CueAuthError extends Error {}

/**
 * Manus sign-in hands its session back on a cue:// or cuedev:// link. cue://
 * belongs to the Cue app; cuedev:// (Cue's dev builds) is free, so AgentStudio
 * takes that one while a sign-in runs.
 */
export const CUE_SCHEME = "cuedev";

/** The token in a cuedev://oauth/desktop-callback link, if it is the answer to this sign-in. */
export function callbackToken(raw: string, nonce: string): { token: string } | { error: true } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${CUE_SCHEME}:` || url.hostname !== "oauth" || url.pathname !== "/desktop-callback") return null;
  if (url.searchParams.get("nonce") !== nonce) return null;
  if (url.searchParams.has("error")) return { error: true };
  const token = url.searchParams.get("token");
  return token ? { token } : null;
}



// ---- the API -------------------------------------------------------------------------

type Envelope = { ok?: boolean; error?: { code?: string; message?: string } } & Record<string, unknown>;

export type CueEvent = {
  id: string;
  type: string;
  timestamp: number;
  user_message?: { content?: string; attachments?: CueAttachment[] };
  assistant_message?: {
    content?: string;
    attachments?: CueAttachment[];
    question_expectation?: { options?: string[]; selection_mode?: string };
  };
  error_message?: { content?: string; error_type?: string };
  status_update?: {
    agent_status?: "running" | "stopped" | "waiting" | "error";
    brief?: string;
    status_detail?: {
      waiting_for_event_id?: string;
      waiting_for_event_type?: string;
      waiting_description?: string;
      confirm_input_schema?: { properties?: Record<string, { type?: string; enum?: unknown[] }> };
    };
  };
};
type CueAttachment = { type?: string; filename?: string; url?: string; content_type?: string };

/** A minimal sliding-window limiter, shared by every agent of one account. */
class Budget {
  private stamps: number[] = [];
  constructor(private readonly perMinute: number) {}
  async take(signal?: AbortSignal) {
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter((t) => now - t < 60_000);
      if (this.stamps.length < this.perMinute) {
        this.stamps.push(now);
        return;
      }
      await new Promise((r) => setTimeout(r, 60_000 - (now - this.stamps[0]!) + 50));
      if (signal?.aborted) return;
    }
  }
}

export class CueClient {
  private readonly listBudget: Budget;
  constructor(
    private readonly cfg: CueConfig,
    readonly apiKey: string,
  ) {
    this.listBudget = new Budget(cfg.listBudgetPerMinute);
  }

  private async call(method: "GET" | "POST", path: string, params: Record<string, unknown>): Promise<Envelope> {
    let url = `${this.cfg.apiUrl}/v2/${path}`;
    const init: RequestInit = {
      method,
      headers: { "x-manus-api-key": this.apiKey, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      signal: AbortSignal.timeout(20_000),
    };
    if (method === "GET") {
      const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
      url += `?${q}`;
    } else {
      init.body = JSON.stringify(params);
    }
    const res = await fetch(url, init);
    const body = (await res.json().catch(() => ({}))) as Envelope;
    this.cfg.trace?.("cue.api", { path, status: res.status, ok: body.ok, code: body.error?.code });
    if (res.status === 401 || res.status === 403 || body.error?.code === "unauthenticated" || body.error?.code === "permission_denied") {
      throw new CueAuthError("The Manus API key was rejected; connect Cue again with a new key");
    }
    if (!res.ok || body.ok === false) throw new Error(body.error?.message || `Manus API ${path}: HTTP ${res.status}`);
    return body;
  }

  /** The account the key belongs to (also checks the key). */
  async me(): Promise<{ name: string; email: string }> {
    const r = await this.call("GET", "user.me", {});
    return { name: String(r.name ?? ""), email: String(r.email ?? "") };
  }

  /** Every agent of the account: the default IM agent ("Cue") and the ones created in the Cue app. */
  async listAgents(): Promise<CueAgentRef[]> {
    const r = await this.call("GET", "agent.list", {});
    const list = ((r.data as Record<string, unknown>[] | undefined) ?? []).map(agentRef);
    const im = await this.call("GET", "agent.detail", { agent_id: "agent-default" })
      .then((d) => agentRef((d.agent ?? {}) as Record<string, unknown>))
      .catch(() => null);
    if (im?.taskId && !list.some((a) => a.taskId === im.taskId)) list.unshift({ ...im, name: im.name || "Cue" });
    return list.filter((a) => a.taskId);
  }

  /** The newest events of a task, oldest first. */
  async events(taskId: string, limit = 30): Promise<CueEvent[]> {
    await this.listBudget.take();
    const r = await this.call("GET", "task.listMessages", { task_id: taskId, order: "desc", limit });
    return ((r.messages as CueEvent[] | undefined) ?? []).slice().sort((a, b) => a.timestamp - b.timestamp);
  }

  async send(taskId: string, text: string) {
    await this.call("POST", "task.sendMessage", { task_id: taskId, message: { content: text } });
  }

  async confirm(taskId: string, eventId: string, input: Record<string, unknown>) {
    const r = await this.call("POST", "task.confirmAction", { task_id: taskId, event_id: eventId, input });
    if (r.confirmed === false) throw new Error("Cue didn't accept the answer");
  }
}

function agentRef(a: Record<string, unknown>): CueAgentRef {
  return { id: String(a.id ?? ""), taskId: String(a.task_id ?? ""), name: String(a.nickname ?? ""), about: String(a.about ?? "") };
}

// ---- turning events into AgentStudio events (pure, unit-tested) -------------------------------

const DENY_WORDS = /^(no|don'?t|do not|cancel|skip|reject|deny|decline|not now|stop)\b/i;
/** Choice key meaning "leave the question for the Cue app". */
export const CUE_DISMISS = "__agentstudio_dismiss";

/** Approval choices for an agent question's options. */
export function questionChoices(options: string[]): Choice[] {
  const choices: Choice[] = options.slice(0, 6).map((o, i) => ({ key: `o${i}`, label: truncate(o, 80), category: DENY_WORDS.test(o) ? "deny" : "approve" }));
  if (!choices.some((c) => c.category === "deny")) choices.push({ key: CUE_DISMISS, label: "Answer in Cue", category: "deny" });
  return choices;
}

/** What to send for an action confirmation, keyed by choice; null when AgentStudio can't answer it. */
export function confirmationChoices(
  detail: NonNullable<NonNullable<CueEvent["status_update"]>["status_detail"]>,
): { choices: Choice[]; inputs: Record<string, Record<string, unknown>> } | null {
  const props = detail.confirm_input_schema?.properties ?? {};
  if (props.accept?.type === "boolean" || !detail.confirm_input_schema) {
    return {
      choices: [
        { key: "accept", label: "Approve", category: "approve" },
        { key: "reject", label: "Deny", category: "deny" },
      ],
      inputs: { accept: { accept: true }, reject: { accept: false } },
    };
  }
  for (const field of ["action", "choice"]) {
    const values = (props[field]?.enum ?? []).filter((v): v is string => typeof v === "string");
    if (values.length > 0 && values.length <= 4) {
      const choices: Choice[] = values.map((v) => ({ key: v, label: v.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), category: DENY_WORDS.test(v) ? "deny" : "approve" }));
      if (!choices.some((c) => c.category === "approve")) choices[0]!.category = "approve";
      if (!choices.some((c) => c.category === "deny")) choices[choices.length - 1]!.category = "deny";
      return { choices, inputs: Object.fromEntries(values.map((v) => [v, { [field]: v }])) };
    }
  }
  return null;
}

/** A message's files, for the bridge to bring over (signed URLs; images show inline). */
export function attachmentsOf(list: CueAttachment[] | undefined): Attachment[] {
  return (list ?? [])
    .filter((a) => a.url && /^https?:\/\//.test(a.url))
    .slice(0, 10)
    .map((a) => ({ url: a.url!, name: a.filename || a.type || "file", ...(a.content_type ? { mime_type: a.content_type } : {}) }));
}

/** The chat message for a Cue event (an answer, or what the user said in the Cue app), or null. */
export function messageOf(e: CueEvent): Extract<AgentEvent, { type: "message" }> | null {
  if (e.type === "assistant_message") {
    const m = e.assistant_message ?? {};
    const text = (m.content ?? "").trim();
    const attachments = attachmentsOf(m.attachments);
    if (!text && attachments.length === 0) return null;
    return { type: "message", text: truncate(text, MAX_TEXT), ...(attachments.length ? { attachments } : {}) };
  }
  if (e.type === "user_message") {
    const m = e.user_message ?? {};
    const text = (m.content ?? "").trim();
    const attachments = attachmentsOf(m.attachments);
    if (!text && attachments.length === 0) return null;
    return { type: "message", text: truncate(text, MAX_TEXT), from_user: true, via: "Cue", ...(attachments.length ? { attachments } : {}) };
  }
  return null;
}

/** The last messages of a conversation, as history (oldest first). */
export function historyOf(events: CueEvent[], max = HISTORY_ON_CONNECT): Extract<AgentEvent, { type: "message" }>[] {
  const out: Extract<AgentEvent, { type: "message" }>[] = [];
  for (const e of events) {
    const m = messageOf(e);
    if (m) out.push({ ...m, history: true, ts: new Date(e.timestamp).toISOString() });
  }
  return out.slice(-max);
}

// ---- the connector ------------------------------------------------------------------------

type Pending =
  | { kind: "question"; options: string[] }
  | { kind: "confirm"; eventId: string; inputs: Record<string, Record<string, unknown>> };

export class CueConnector implements Connector {
  private emitter: Emitter | null = null;
  private running = false;
  private status: ConnectorState = { status: "starting" };
  private timer: NodeJS.Timeout | null = null;
  private activeUntil = 0;
  private seen = new Set<string>();
  private ownTexts = new Set<string>();
  private pending = new Map<string, Pending>();
  private pendingAsk: { taskId: string; texts: string[] } | null = null;

  constructor(
    private readonly cfg: CueConfig,
    private data: CueData,
    private readonly client: CueClient,
    private readonly onChange: () => void,
    /** The Cue app icon: the Manus API doesn't expose agents' avatars. */
    private readonly fallbackAvatar: () => Promise<AvatarImage | null>,
  ) {}

  info(): AgentInfo {
    return {
      name: this.data.agent.name || "Cue",
      description: this.data.agent.about || "Your Cue agent, through your own Manus account.",
      capabilities: ["chat", "ask", "approvals"],
      protocol: "agentstudio-agent/0",
    };
  }

  state(): ConnectorState {
    return this.status;
  }

  serialize(): unknown {
    return this.data;
  }

  async avatar(): Promise<AvatarImage | null> {
    return this.fallbackAvatar();
  }

  async start(emitter: Emitter): Promise<void> {
    this.emitter = emitter;
    this.running = true;
    try {
      await this.refreshProfile();
      // Earlier events are history, not new messages. On the first connect,
      // the last few come over as history so the chat isn't empty.
      const events = await this.client.events(this.data.agent.taskId, 50);
      for (const e of events) this.seen.add(e.id);
      if (this.data.since === undefined) {
        for (const m of historyOf(events)) emitter.emit(m);
        this.data.since = Math.max(0, ...events.map((e) => e.timestamp));
        this.onChange();
      }
      this.status = { status: "ready" };
    } catch (err) {
      this.status = { status: err instanceof CueAuthError ? "needs_login" : "error", message: String((err as Error).message) };
    }
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  async send(msg: InboundMessage): Promise<void> {
    const text = msg.ask ? askPrompt(msg.ask) : msg.text;
    if (msg.ask) this.pendingAsk = { taskId: msg.ask.task_id, texts: [] };
    this.ownTexts.add(text.trim());
    await this.client.send(this.data.agent.taskId, text);
    // A plain message answers (or skips) whatever Cue was waiting for.
    for (const id of this.pending.keys()) this.emitter?.emit({ type: "approval_cancel", external_id: id });
    this.pending.clear();
    this.emitter?.emit({ type: "status", state: "working", text: "Working" });
    this.wake();
  }

  async decide(externalId: string, choice: string): Promise<void> {
    const p = this.pending.get(externalId);
    if (!p) throw new UnknownApprovalError();
    this.pending.delete(externalId);
    if (p.kind === "question") {
      if (choice === CUE_DISMISS) return;
      const option = p.options[Number(choice.slice(1))];
      if (option === undefined) throw new Error("unknown choice");
      this.ownTexts.add(option.trim());
      await this.client.send(this.data.agent.taskId, option);
    } else {
      const input = p.inputs[choice];
      if (!input) throw new Error("unknown choice");
      await this.client.confirm(this.data.agent.taskId, p.eventId, input);
    }
    this.wake();
  }

  /** Picks up a new name or description set in Cue. */
  private async refreshProfile() {
    const list = await this.client.listAgents().catch(() => null);
    const fresh = list?.find((a) => a.taskId === this.data.agent.taskId);
    if (!fresh) return;
    const cur = this.data.agent;
    if (fresh.name === cur.name && fresh.about === cur.about) return;
    this.data.agent = { ...cur, ...fresh, name: fresh.name || cur.name };
    this.onChange();
    this.emitter?.profileChanged();
  }

  private wake() {
    this.activeUntil = Date.now() + 10 * 60_000;
    this.schedule(this.cfg.pollActiveMs);
  }

  private schedule(ms: number) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick() {
    if (!this.running) return;
    try {
      this.process(await this.client.events(this.data.agent.taskId));
      this.status = { status: "ready" };
    } catch (err) {
      this.status = { status: err instanceof CueAuthError ? "needs_login" : "error", message: String((err as Error).message) };
      this.cfg.trace?.("cue.poll_error", { message: this.status.message });
    }
    this.schedule(Date.now() < this.activeUntil ? this.cfg.pollActiveMs : this.cfg.pollIdleMs);
  }

  private process(events: CueEvent[]) {
    const emit = (e: Parameters<Emitter["emit"]>[0]) => this.emitter?.emit(e);
    for (const e of events) {
      if (this.seen.has(e.id)) continue;
      this.seen.add(e.id);
      if (e.timestamp <= (this.data.since ?? 0)) continue;
      this.cfg.trace?.("cue.event", { type: e.type, status: e.status_update?.agent_status, waiting: e.status_update?.status_detail?.waiting_for_event_type });
      switch (e.type) {
        case "user_message": {
          const text = (e.user_message?.content ?? "").trim();
          if (this.ownTexts.delete(text)) break;
          // Said in the Cue app: show it, and whatever AgentStudio was asking is moot.
          const m = messageOf(e);
          if (m) emit(m);
          for (const id of this.pending.keys()) emit({ type: "approval_cancel", external_id: id });
          this.pending.clear();
          break;
        }
        case "assistant_message": {
          const m = e.assistant_message ?? {};
          const options = m.question_expectation?.options ?? [];
          if (options.length > 0) {
            const id = `q:${e.id}`;
            this.pending.set(id, { kind: "question", options });
            emit({ type: "approval_request", external_id: id, title: truncate((m.content ?? "").trim() || "Cue has a question", 300), choices: questionChoices(options) });
            break;
          }
          const msg = messageOf(e);
          if (!msg) break;
          if (this.pendingAsk && msg.text) this.pendingAsk.texts.push(msg.text);
          else emit(msg);
          break;
        }
        case "error_message":
          emit({ type: "message", text: `⚠️ ${e.error_message?.content || "Cue ran into an error."}` });
          emit({ type: "status", state: "idle" });
          break;
        case "status_update": {
          const s = e.status_update ?? {};
          if (s.agent_status === "running") {
            emit({ type: "status", state: "working", text: truncate(s.brief || "Working", 80) });
            this.activeUntil = Math.max(this.activeUntil, Date.now() + 10 * 60_000);
            break;
          }
          if (s.agent_status === "waiting") {
            const d = s.status_detail ?? {};
            const type = d.waiting_for_event_type ?? "";
            if (type !== "messageAskUser" && type !== "cascadeAskUser" && d.waiting_for_event_id) {
              const c = confirmationChoices(d);
              const id = `c:${d.waiting_for_event_id}`;
              if (c && !this.pending.has(id)) {
                this.pending.set(id, { kind: "confirm", eventId: d.waiting_for_event_id, inputs: c.inputs });
                emit({ type: "approval_request", external_id: id, title: truncate(d.waiting_description || "Cue needs your confirmation", 300), choices: c.choices });
              } else if (!c) {
                emit({ type: "message", text: `Cue is waiting for you: ${d.waiting_description || type}. Answer it in the Cue app.` });
              }
            }
          }
          if (s.agent_status === "stopped" || s.agent_status === "error" || s.agent_status === "waiting") {
            this.flushAsk();
            emit({ type: "status", state: "idle" });
          }
          break;
        }
      }
    }
    // Remember how far we got (server time), so a restart doesn't replay.
    const latest = Math.max(this.data.since ?? 0, ...events.map((e) => e.timestamp));
    if (latest !== this.data.since) {
      this.data.since = latest;
      this.onChange();
    }
    // Keep the memory of seen events bounded.
    if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-1000));
  }

  private flushAsk() {
    const ask = this.pendingAsk;
    if (!ask || ask.texts.length === 0) return;
    this.pendingAsk = null;
    this.emitter?.emit({ type: "drafts", task_id: ask.taskId, drafts: parseDrafts(ask.texts[ask.texts.length - 1]!).map((text) => ({ text })) });
  }
}

/** A stable key for one API key, to share a client between its agents without keeping the key in a map key. */
export function cueAccountKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}
