import { microtask } from "./platform.js";

// A tiny observable store compatible with React's useSyncExternalStore:
//   const snap = useSyncExternalStore(store.subscribe, store.getSnapshot)
// Snapshots are replaced, never mutated, so identity changes mean "changed".

export type Listener = () => void;
export type Unsubscribe = () => void;

export interface ReadableStore<T> {
  subscribe(listener: Listener): Unsubscribe;
  getSnapshot(): T;
}

export class Store<T> implements ReadableStore<T> {
  private listeners = new Set<Listener>();

  constructor(private value: T) {}

  // Arrow properties so they can be passed unbound to useSyncExternalStore.
  subscribe = (listener: Listener): Unsubscribe => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): T => this.value;

  set(next: T): void {
    if (Object.is(next, this.value)) return;
    this.value = next;
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        // A broken listener must not stop the others.
      }
    }
  }

  update(fn: (prev: T) => T): void {
    this.set(fn(this.value));
  }
}

/** A change source with a monotonically increasing version number. */
export interface VersionedSource {
  subscribe(listener: Listener): Unsubscribe;
  version(): number;
}

/**
 * A derived store: recomputes `compute()` lazily when the source's version
 * changes. The snapshot stays referentially stable between changes, which is
 * what useSyncExternalStore requires.
 */
export function derived<T>(source: VersionedSource, compute: () => T): ReadableStore<T> {
  let seen = -1;
  let cached: T;
  return {
    subscribe: (l) => source.subscribe(l),
    getSnapshot: () => {
      const v = source.version();
      if (v !== seen) {
        cached = compute();
        seen = v;
      }
      return cached;
    },
  };
}

/** A simple versioned change emitter. `emit()` batches into one microtask. */
export class ChangeEmitter implements VersionedSource {
  private v = 0;
  private listeners = new Set<Listener>();
  private scheduled = false;

  subscribe = (l: Listener): Unsubscribe => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  version = (): number => this.v;

  /** Bump the version now and notify listeners on the next microtask. */
  emit(): void {
    this.v++;
    if (this.scheduled) return;
    this.scheduled = true;
    microtask(() => {
      this.scheduled = false;
      for (const l of [...this.listeners]) {
        try {
          l();
        } catch {
          // ignore listener errors
        }
      }
    });
  }
}
