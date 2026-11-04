import { useEffect, useState, useSyncExternalStore } from "react";
import type { ReadableStore, VersionedSource } from "@agentstudio/core";

/** Subscribe a component to a @agentstudio/core store. */
export function useStore<T>(store: ReadableStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/** Re-render on every change of a versioned source (e.g. AgentStudioMatrix). */
export function useVersion(source: VersionedSource): number {
  return useSyncExternalStore(source.subscribe, source.version);
}

/** The current time, refreshed every `intervalMs`. */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
