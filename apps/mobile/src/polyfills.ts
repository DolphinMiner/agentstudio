// Runtime polyfills for matrix-js-sdk and @agentstudio/core. Imported first by index.ts.
//
// Web (react-native-web in a browser) already has everything: fetch,
// AbortController, URL, TextEncoder, crypto.getRandomValues/randomUUID.
//
// Native (iOS/Android, not yet exercised in v0.1 because there is no Xcode or
// Android SDK on the dev machine):
// - URL, URLSearchParams, TextEncoder/TextDecoder, structuredClone and
//   AbortController come from React Native and Expo's "winter" runtime.
// - crypto.getRandomValues / crypto.randomUUID are missing; they are installed
//   here from expo-crypto (matrix-js-sdk uses them for transaction ids).
// - IndexedDB is missing; AgentStudioMatrix runs with the SDK's in-memory store.
// - Not verified yet: Metro/Hermes bundling of matrix-js-sdk on native.
import { Platform } from "react-native";
import { getRandomValues, randomUUID } from "expo-crypto";

type CryptoLike = {
  getRandomValues?: (a: Uint8Array) => Uint8Array;
  randomUUID?: () => string;
};

if (Platform.OS !== "web") {
  const g = globalThis as unknown as { crypto?: CryptoLike };
  const c: CryptoLike = g.crypto ?? {};
  if (!c.getRandomValues) c.getRandomValues = (a) => getRandomValues(a);
  if (!c.randomUUID) c.randomUUID = () => randomUUID();
  if (!g.crypto) g.crypto = c;
}
