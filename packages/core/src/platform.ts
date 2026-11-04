// Minimal typings for the web-platform globals that exist on every AgentStudio
// target (Electron renderer, React Native / Hermes, browsers, Node >= 22).
// @agentstudio/core is compiled without the DOM or Node libs, so we describe just
// the parts we use and reach them through globalThis.

export interface HeadersLike {
  get(name: string): string | null;
}

export interface ResponseLike {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: HeadersLike;
  text(): Promise<string>;
}

export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

export interface AbortControllerLike {
  readonly signal: AbortSignalLike;
  abort(reason?: unknown): void;
}

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignalLike;
}

export type FetchLike = (url: string, init?: FetchInit) => Promise<ResponseLike>;

type TimerHandle = unknown;

interface PlatformGlobals {
  fetch?: FetchLike;
  AbortController?: new () => AbortControllerLike;
  queueMicrotask?: (fn: () => void) => void;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
  crypto?: {
    randomUUID?: () => string;
    getRandomValues?: <T extends Uint8Array>(arr: T) => T;
  };
}

const g = globalThis as unknown as PlatformGlobals;

export type { TimerHandle };

export function setTimer(fn: () => void, ms: number): TimerHandle {
  return g.setTimeout(fn, ms);
}
export function clearTimer(h: TimerHandle | undefined): void {
  if (h !== undefined) g.clearTimeout(h);
}
export function setRepeating(fn: () => void, ms: number): TimerHandle {
  return g.setInterval(fn, ms);
}
export function clearRepeating(h: TimerHandle | undefined): void {
  if (h !== undefined) g.clearInterval(h);
}

export function microtask(fn: () => void): void {
  if (g.queueMicrotask) g.queueMicrotask(fn);
  else void Promise.resolve().then(fn);
}

export function defaultFetch(): FetchLike {
  if (!g.fetch) throw new Error("@agentstudio/core: no global fetch; pass one in the options");
  // Bind so implementations that check `this` (browsers) do not throw.
  return g.fetch.bind(globalThis) as FetchLike;
}

export function newAbortController(): AbortControllerLike | null {
  return g.AbortController ? new g.AbortController() : null;
}

/** Random UUID v4. Uses crypto.randomUUID when available. */
export function randomId(): string {
  const c = g.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Idempotency key for approval decisions and task creation. */
export function newIdempotencyKey(): string {
  return randomId();
}
