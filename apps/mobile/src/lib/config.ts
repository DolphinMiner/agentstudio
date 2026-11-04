// Build-time configuration. Expo inlines EXPO_PUBLIC_* variables at bundle time.

export const DEFAULT_SERVER_URL = "http://127.0.0.1:18090";

/** Trim, drop trailing slashes and fall back to the default for empty/invalid input. */
export function normalizeServerUrl(raw: string | undefined | null): string {
  const v = (raw ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/i.test(v)) return DEFAULT_SERVER_URL;
  return v;
}

export const SERVER_URL = normalizeServerUrl(process.env.EXPO_PUBLIC_AGENTSTUDIO_SERVER_URL);

export const APP_VERSION = "0.1.0";
