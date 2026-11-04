// A REST-backed list store that polls (default every 15 s) and can be
// triggered early, e.g. when a com.agentstudio.approval message arrives.

import { clearRepeating, clearTimer, setRepeating, setTimer, type TimerHandle } from "./platform.js";
import { Store, type Listener, type Unsubscribe } from "./store.js";

export type ListSnapshot<T> = {
  items: T[];
  /** True until the first fetch has finished (successfully or not). */
  loading: boolean;
  error: unknown | null;
  updatedAt: number | null;
};

export interface PollingOptions {
  intervalMs?: number; // default 15000
  /** Trigger debounce, so a burst of events causes one fetch (default 250 ms). */
  debounceMs?: number;
}

export class PollingList<T extends { id: string }> {
  protected readonly state = new Store<ListSnapshot<T>>({
    items: [],
    loading: true,
    error: null,
    updatedAt: null,
  });
  private timer: TimerHandle | undefined;
  private debounce: TimerHandle | undefined;
  private inflight: Promise<void> | null = null;
  private again = false;
  private readonly intervalMs: number;
  private readonly debounceMs: number;

  constructor(
    private readonly fetcher: () => Promise<T[]>,
    opts: PollingOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 15_000;
    this.debounceMs = opts.debounceMs ?? 250;
  }

  subscribe = (l: Listener): Unsubscribe => this.state.subscribe(l);
  getSnapshot = (): ListSnapshot<T> => this.state.getSnapshot();

  get items(): T[] {
    return this.state.getSnapshot().items;
  }

  /** Start polling (fetches immediately). Call stop() when hidden/unmounted. */
  start(): void {
    if (this.timer !== undefined) return;
    void this.refresh();
    this.timer = setRepeating(() => void this.refresh(), this.intervalMs);
  }

  stop(): void {
    clearRepeating(this.timer);
    clearTimer(this.debounce);
    this.timer = undefined;
    this.debounce = undefined;
  }

  /** Refresh soon (debounced). */
  trigger(): void {
    clearTimer(this.debounce);
    this.debounce = setTimer(() => {
      this.debounce = undefined;
      void this.refresh();
    }, this.debounceMs);
  }

  /** Fetch now. Concurrent calls coalesce; a call during a fetch queues one more. */
  refresh(): Promise<void> {
    if (this.inflight) {
      this.again = true;
      return this.inflight;
    }
    this.inflight = (async () => {
      do {
        this.again = false;
        try {
          const items = await this.fetcher();
          this.state.set({ items, loading: false, error: null, updatedAt: Date.now() });
        } catch (error) {
          this.state.update((s) => ({ ...s, loading: false, error }));
        }
      } while (this.again);
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Insert or replace one item locally (e.g. after a mutation). */
  upsert(item: T): void {
    this.state.update((s) => {
      const i = s.items.findIndex((x) => x.id === item.id);
      const items = i < 0 ? [item, ...s.items] : s.items.map((x, j) => (j === i ? item : x));
      return { ...s, items };
    });
  }

  get(id: string): T | undefined {
    return this.items.find((x) => x.id === id);
  }
}
