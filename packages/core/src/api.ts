// Typed client for the AgentStudio REST API (docs/api.md).
//
// - Base URL is injected (string or getter, so settings can change it).
// - Bearer auth with automatic access-token refresh: proactive shortly before
//   `access_expires_at`, and reactive on a 401. Refresh is single-flight, which
//   matters because refresh tokens rotate and reusing an old one revokes the
//   whole session.

import {
  defaultFetch,
  newAbortController,
  setTimer,
  clearTimer,
  type AbortSignalLike,
  type FetchLike,
} from "./platform.js";
import type {
  Agent,
  ApiErrorCode,
  Approval,
  Connection,
  DevOutboxMessage,
  Health,
  LoginStep,
  LoginStepInput,
  Network,
  Session,
  Task,
  TaskOrigin,
  User,
} from "./types.js";

export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    /** For 409 version_conflict: the current server object. */
    readonly current?: unknown,
  ) {
    super(message);
  }

  get isConflict(): boolean {
    return this.status === 409 && this.code === "version_conflict";
  }
}

export function isApiError(e: unknown, code?: ApiErrorCode): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code);
}

export interface ApiClientOptions {
  /** e.g. "http://127.0.0.1:18090". A getter is re-read for every request. */
  baseUrl: string | (() => string);
  fetch?: FetchLike;
  /** Per-request timeout in ms (default 20 s; long polls use their own). */
  timeoutMs?: number;
  /** Refresh this many ms before access_expires_at (default 60 s). */
  refreshSkewMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

export type SessionListener = (session: Session | null, reason: SessionChangeReason) => void;
export type SessionChangeReason = "set" | "refreshed" | "revoked" | "cleared";

interface RequestOpts {
  body?: unknown;
  auth?: boolean;
  timeoutMs?: number;
  signal?: AbortSignalLike;
  query?: Record<string, string | undefined>;
}

export type DecisionInput = { choice: string; version: number; idempotency_key: string };
export type CreateTaskInput = {
  agent_id: string;
  idempotency_key: string;
  request_text: string;
  origin: TaskOrigin;
  /** Anchor message text; the API keeps its first line (80 chars). */
  title?: string;
};

export class ApiClient {
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly skewMs: number;
  private readonly now: () => number;
  private session: Session | null = null;
  private refreshing: Promise<Session | null> | null = null;
  private listeners = new Set<SessionListener>();

  constructor(private readonly opts: ApiClientOptions) {
    this.fetchFn = opts.fetch ?? defaultFetch();
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.skewMs = opts.refreshSkewMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  get baseUrl(): string {
    const b = typeof this.opts.baseUrl === "function" ? this.opts.baseUrl() : this.opts.baseUrl;
    return b.replace(/\/+$/, "");
  }

  // ---- session state -------------------------------------------------------

  getSession(): Session | null {
    return this.session;
  }

  /** Install (or clear with null) the session used for authenticated calls. */
  setSession(session: Session | null): void {
    this.session = session;
    this.emit(session, session ? "set" : "cleared");
  }

  /** Called on refresh (rotated tokens) and revocation. Persist from here. */
  onSessionChange(l: SessionListener): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  private emit(s: Session | null, reason: SessionChangeReason) {
    for (const l of [...this.listeners]) {
      try {
        l(s, reason);
      } catch {
        // ignore listener errors
      }
    }
  }

  /**
   * Refresh the access token. Concurrent callers share one request.
   * Resolves to the new session, or null when the session was revoked
   * (the session is then cleared). Network errors reject and keep the session.
   */
  refreshSession(): Promise<Session | null> {
    if (this.refreshing) return this.refreshing;
    const current = this.session;
    if (!current) return Promise.resolve(null);
    const p = (async () => {
      try {
        const next = await this.request<Session>("POST", "/v1/auth/refresh", {
          auth: false,
          body: { refresh_token: current.refresh_token },
        });
        // Ignore the result if someone signed out / in meanwhile.
        if (this.session?.session_id !== current.session_id) return this.session;
        this.session = next;
        this.emit(next, "refreshed");
        return next;
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          if (this.session?.session_id === current.session_id) {
            this.session = null;
            this.emit(null, "revoked");
          }
          return null;
        }
        throw e;
      } finally {
        this.refreshing = null;
      }
    })();
    this.refreshing = p;
    return p;
  }

  private needsProactiveRefresh(s: Session): boolean {
    const exp = Date.parse(s.access_expires_at);
    return Number.isFinite(exp) && exp - this.skewMs <= this.now();
  }

  // ---- transport -----------------------------------------------------------

  private async authed<T>(method: string, path: string, opts: RequestOpts = {}): Promise<T> {
    let s = this.session;
    if (!s) throw new ApiError(401, "unauthenticated", "Not signed in");
    if (this.needsProactiveRefresh(s) || this.refreshing) {
      s = await this.refreshSession();
      if (!s) throw new ApiError(401, "unauthenticated", "Session expired");
    }
    const token = s.access_token;
    try {
      return await this.request<T>(method, path, { ...opts, auth: false }, token);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) throw e;
      // If another call already refreshed since we started, just retry.
      let next = this.session;
      if (!next) throw e;
      if (next.access_token === token) {
        next = await this.refreshSession();
        if (!next) throw e;
      }
      return this.request<T>(method, path, { ...opts, auth: false }, next.access_token);
    }
  }

  private async request<T>(
    method: string,
    path: string,
    opts: RequestOpts,
    bearer?: string,
  ): Promise<T> {
    let url = this.baseUrl + path;
    if (opts.query) {
      const qs = Object.entries(opts.query)
        .filter((kv): kv is [string, string] => kv[1] !== undefined)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&");
      if (qs) url += `?${qs}`;
    }
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (bearer) headers["Authorization"] = `Bearer ${bearer}`;

    const ctrl = newAbortController();
    let timedOut = false;
    const timer = ctrl
      ? setTimer(() => {
          timedOut = true;
          ctrl.abort();
        }, opts.timeoutMs ?? this.timeoutMs)
      : undefined;
    const outer = opts.signal;
    const onOuterAbort = () => ctrl?.abort();
    if (outer) {
      if (outer.aborted) ctrl?.abort();
      else outer.addEventListener("abort", onOuterAbort, { once: true });
    }

    let res;
    let text: string;
    try {
      res = await this.fetchFn(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: ctrl?.signal,
      });
      text = await res.text();
    } catch (e) {
      if (timedOut) throw new ApiError(0, "timeout", `Request timed out: ${method} ${path}`);
      if (outer?.aborted) throw new ApiError(0, "aborted", "Request aborted");
      throw new ApiError(0, "network_error", `Network error: ${(e as Error)?.message ?? e}`);
    } finally {
      clearTimer(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    }

    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        if (res.ok) throw new ApiError(res.status, "bad_response", "Invalid JSON from server");
      }
    }
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string; current?: unknown } })
        ?.error;
      throw new ApiError(
        res.status,
        err?.code ?? statusToCode(res.status),
        err?.message ?? `HTTP ${res.status}`,
        err?.current,
      );
    }
    return data as T;
  }

  // ---- health and dev ------------------------------------------------------

  health(): Promise<Health> {
    return this.request("GET", "/v1/health", {});
  }

  /** Dev only (AGENTSTUDIO_DEV=1): sign-in mails, newest first. */
  async devOutbox(email: string): Promise<DevOutboxMessage[]> {
    const r = await this.request<{ messages: DevOutboxMessage[] }>("GET", "/v1/dev/outbox", {
      query: { email },
    });
    return r.messages;
  }

  // ---- auth ----------------------------------------------------------------

  async startEmailSignIn(email: string): Promise<void> {
    await this.request("POST", "/v1/auth/email/start", { body: { email } });
  }

  /** Returns a Session. Does not install it; see SessionManager. */
  verifyEmailSignIn(email: string, code: string, deviceName: string): Promise<Session> {
    return this.request("POST", "/v1/auth/email/verify", {
      body: { email, code, device_name: deviceName },
    });
  }

  /** Local mode only (Health.local): signs in the person on this Mac, without email. */
  localSignIn(deviceName: string): Promise<Session> {
    return this.request("POST", "/v1/auth/local", { body: { device_name: deviceName } });
  }

  /** Revokes the current session on the server. Does not clear local state. */
  async logout(): Promise<void> {
    await this.authed("POST", "/v1/auth/logout");
  }

  async me(): Promise<User> {
    return (await this.authed<{ user: User }>("GET", "/v1/me")).user;
  }

  // ---- networks and connections -------------------------------------------

  async networks(): Promise<Network[]> {
    // Public route, but harmless to send auth if we have it.
    return (await this.request<{ networks: Network[] }>("GET", "/v1/networks", {})).networks;
  }

  async connections(): Promise<Connection[]> {
    return (await this.authed<{ connections: Connection[] }>("GET", "/v1/connections"))
      .connections;
  }

  startLogin(network: string, flowId: string): Promise<{ process_id: string; step: LoginStep }> {
    return this.authed("POST", `/v1/connections/${enc(network)}/logins`, {
      body: { flow_id: flowId },
    });
  }

  async submitLoginStep(
    processId: string,
    stepId: string,
    input: LoginStepInput = {},
  ): Promise<LoginStep> {
    const r = await this.authed<{ step: LoginStep }>(
      "POST",
      `/v1/connections/logins/${enc(processId)}/steps/${enc(stepId)}`,
      { body: input },
    );
    return r.step;
  }

  /**
   * Long poll (server waits up to 60 s) for a display_and_wait step. On a
   * server-side timeout the unchanged step comes back; call again.
   */
  async waitLoginStep(processId: string, stepId: string, signal?: AbortSignalLike): Promise<LoginStep> {
    const r = await this.authed<{ step: LoginStep }>(
      "POST",
      `/v1/connections/logins/${enc(processId)}/steps/${enc(stepId)}/wait`,
      { timeoutMs: 75_000, signal },
    );
    return r.step;
  }

  async deleteConnection(connectionId: string): Promise<void> {
    await this.authed("DELETE", `/v1/connections/${enc(connectionId)}`);
  }

  // ---- agents --------------------------------------------------------------

  async agents(): Promise<Agent[]> {
    return (await this.authed<{ agents: Agent[] }>("GET", "/v1/agents")).agents;
  }

  setAgentConsent(agentId: string, askWithoutPreview: boolean): Promise<Agent> {
    return this.authed("PUT", `/v1/agents/${enc(agentId)}/consent`, {
      body: { ask_without_preview: askWithoutPreview },
    });
  }

  // ---- approvals -----------------------------------------------------------

  async approvals(state: "pending" | "all" = "pending"): Promise<Approval[]> {
    return (
      await this.authed<{ approvals: Approval[] }>("GET", "/v1/approvals", { query: { state } })
    ).approvals;
  }

  approval(id: string): Promise<Approval> {
    return this.authed("GET", `/v1/approvals/${enc(id)}`);
  }

  decideApproval(id: string, input: DecisionInput): Promise<Approval> {
    return this.authed("POST", `/v1/approvals/${enc(id)}/decision`, { body: input });
  }

  // ---- tasks ---------------------------------------------------------------

  createTask(input: CreateTaskInput): Promise<Task> {
    return this.authed("POST", "/v1/tasks", { body: input });
  }

  async tasks(state: "open" | "all" = "open"): Promise<Task[]> {
    return (await this.authed<{ tasks: Task[] }>("GET", "/v1/tasks", { query: { state } })).tasks;
  }

  markTaskSent(id: string, input: { version: number; draft_index: number }): Promise<Task> {
    return this.authed("POST", `/v1/tasks/${enc(id)}/sent`, { body: input });
  }

  cancelTask(id: string, input: { version: number }): Promise<Task> {
    return this.authed("POST", `/v1/tasks/${enc(id)}/cancel`, { body: input });
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

function statusToCode(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthenticated";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "version_conflict";
    case 410:
      return "expired";
    case 422:
      return "invalid_code";
    case 429:
      return "rate_limited";
    case 502:
      return "upstream_error";
    default:
      return "bad_response";
  }
}
