// Session persistence (docs/clients.md): expo-secure-store on native,
// localStorage on web.
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import {
  KeyValueSessionStore,
  MemorySessionStore,
  type KeyValueStorage,
  type Session,
  type SessionStore,
} from "@agentstudio/core";

const KEY = "agentstudio.session";

/** Keychain / Keystore-backed store for iOS and Android. */
class SecureSessionStore implements SessionStore {
  async load(): Promise<Session | null> {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Session;
    } catch {
      return null;
    }
  }
  async save(s: Session): Promise<void> {
    await SecureStore.setItemAsync(KEY, JSON.stringify(s), {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
  }
  async clear(): Promise<void> {
    await SecureStore.deleteItemAsync(KEY);
  }
}

export function createSessionStore(): SessionStore {
  if (Platform.OS !== "web") return new SecureSessionStore();
  const ls = (globalThis as unknown as { localStorage?: KeyValueStorage }).localStorage;
  // Private modes or SSR have no localStorage: keep the session in memory.
  return ls ? new KeyValueSessionStore(ls, KEY) : new MemorySessionStore();
}
