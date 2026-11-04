import { useEffect, useSyncExternalStore } from "react";
import type { LocalConnector } from "../../../shared/desktop-api";
import { desktop } from "./desktop";

// The Mac's local connectors, shared by every component that needs them
// (avatars, the Connect screen). Polled while something is subscribed.

let snapshot: LocalConnector[] = [];
let loaded = false;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

export async function refreshLocalConnectors() {
  const next = await desktop.connectors.list().catch(() => snapshot);
  if (!loaded || JSON.stringify(next) !== JSON.stringify(snapshot)) {
    loaded = true;
    snapshot = next;
    for (const l of listeners) l();
  }
}

function subscribe(l: () => void) {
  listeners.add(l);
  if (!timer) {
    void refreshLocalConnectors();
    timer = setInterval(() => void refreshLocalConnectors(), 4000);
  }
  return () => {
    listeners.delete(l);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** The same list as a store (for notifications); null until the first answer from the main process. */
export const localConnectors = {
  subscribe,
  getSnapshot: (): LocalConnector[] | null => (loaded ? snapshot : null),
};

export function useLocalConnectors(): LocalConnector[] {
  const v = useSyncExternalStore(subscribe, () => snapshot);
  useEffect(() => {
    void refreshLocalConnectors();
  }, []);
  return v;
}

export { agentBadge, agentMark } from "./logic";
