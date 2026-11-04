// Session persistence and the sign-in flow.
//
// The app injects a SessionStore (Electron safeStorage via preload,
// expo-secure-store, localStorage, ...). SessionManager keeps the ApiClient's
// session and the store in sync, including rotated refresh tokens.

import type { ApiClient, SessionChangeReason } from "./api.js";
import { Store, type Listener, type Unsubscribe } from "./store.js";
import type { Session } from "./types.js";

export interface SessionStore {
  load(): Promise<Session | null>;
  save(session: Session): Promise<void>;
  clear(): Promise<void>;
}

/** In-memory store, for tests and ephemeral use. */
export class MemorySessionStore implements SessionStore {
  constructor(private value: Session | null = null) {}
  async load() {
    return this.value;
  }
  async save(s: Session) {
    this.value = s;
  }
  async clear() {
    this.value = null;
  }
}

/** Minimal key/value interface (e.g. window.localStorage). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** SessionStore over a synchronous key/value storage such as localStorage. */
export class KeyValueSessionStore implements SessionStore {
  constructor(
    private storage: KeyValueStorage,
    private key = "agentstudio.session",
  ) {}
  async load() {
    const raw = this.storage.getItem(this.key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Session;
    } catch {
      return null;
    }
  }
  async save(s: Session) {
    this.storage.setItem(this.key, JSON.stringify(s));
  }
  async clear() {
    this.storage.removeItem(this.key);
  }
}

export type SessionStatus = "loading" | "signed_out" | "signed_in";

export interface SessionSnapshot {
  status: SessionStatus;
  session: Session | null;
  /** Why the session last changed, e.g. "revoked" when the refresh failed. */
  reason: SessionChangeReason | "loaded" | null;
}

export interface SessionManagerOptions {
  api: ApiClient;
  store: SessionStore;
  /** Shown as the device name in Synapse, e.g. "AgentStudio Desktop (Mac)". */
  deviceName: string;
}

export class SessionManager {
  private readonly api: ApiClient;
  private readonly storage: SessionStore;
  private readonly deviceName: string;
  private readonly state = new Store<SessionSnapshot>({
    status: "loading",
    session: null,
    reason: null,
  });
  private persist: Promise<void> = Promise.resolve();

  constructor(opts: SessionManagerOptions) {
    this.api = opts.api;
    this.storage = opts.store;
    this.deviceName = opts.deviceName;
    // Rotated refresh tokens must be saved, or the next launch would reuse an
    // old one and get the session revoked.
    this.api.onSessionChange((s, reason) => {
      this.queuePersist(s);
      this.state.set({ status: s ? "signed_in" : "signed_out", session: s, reason });
    });
  }

  // useSyncExternalStore-compatible
  subscribe = (l: Listener): Unsubscribe => this.state.subscribe(l);
  getSnapshot = (): SessionSnapshot => this.state.getSnapshot();

  /** Subscribe to session changes with the new session as argument. */
  onChange(cb: (session: Session | null, snapshot: SessionSnapshot) => void): Unsubscribe {
    return this.state.subscribe(() => {
      const snap = this.state.getSnapshot();
      cb(snap.session, snap);
    });
  }

  get session(): Session | null {
    return this.state.getSnapshot().session;
  }

  /** Load the persisted session (if any) into the API client. */
  async init(): Promise<Session | null> {
    let s: Session | null = null;
    try {
      s = await this.storage.load();
    } catch {
      s = null;
    }
    // Set without emitting a persist round-trip.
    this.withoutPersist(() => this.api.setSession(s));
    this.state.set({ status: s ? "signed_in" : "signed_out", session: s, reason: "loaded" });
    return s;
  }

  /** Step 1: ask the server to email a code. */
  startSignIn(email: string): Promise<void> {
    return this.api.startEmailSignIn(email.trim());
  }

  /** Step 2: verify the code; on success the session is installed and saved. */
  async verifySignIn(email: string, code: string): Promise<Session> {
    const s = await this.api.verifyEmailSignIn(email.trim(), code.trim(), this.deviceName);
    this.api.setSession(s);
    await this.persist;
    return s;
  }

  /** Local mode: sign in as the person on this Mac; the session is installed and saved. */
  async signInLocal(): Promise<Session> {
    const s = await this.api.localSignIn(this.deviceName);
    this.api.setSession(s);
    await this.persist;
    return s;
  }

  /** Whether the server runs in local mode (on this Mac, no email sign-in). */
  async isLocalServer(): Promise<boolean> {
    return (await this.api.health()).local === true;
  }

  /** Force a token refresh. Resolves null if the session was revoked. */
  refresh(): Promise<Session | null> {
    return this.api.refreshSession();
  }

  /** Revoke on the server (best effort) and always clear locally. */
  async logout(): Promise<void> {
    if (this.api.getSession()) {
      try {
        await this.api.logout();
      } catch {
        // Offline or already revoked: still sign out locally.
      }
    }
    this.api.setSession(null);
    await this.persist;
  }

  /** Resolves once pending saves to the SessionStore have finished. */
  flush(): Promise<void> {
    return this.persist;
  }

  private skipPersist = false;

  private withoutPersist(fn: () => void) {
    this.skipPersist = true;
    try {
      fn();
    } finally {
      this.skipPersist = false;
    }
  }

  private queuePersist(s: Session | null) {
    if (this.skipPersist) return;
    // Serialize writes so an older session never overwrites a newer one.
    this.persist = this.persist
      .catch(() => undefined)
      .then(() => (s ? this.storage.save(s) : this.storage.clear()));
  }
}
