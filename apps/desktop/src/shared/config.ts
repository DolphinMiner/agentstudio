// Pure helpers shared by the main process and tests: server URL handling and
// the renderer's Content-Security-Policy.

export const DEFAULT_SERVER_URL = "http://127.0.0.1:18090";

/**
 * Validates a server URL and returns its normalised form: http(s) only,
 * no credentials, query or fragment, no trailing slash.
 * Throws an Error with a human message when invalid.
 */
export function normalizeServerUrl(input: string): string {
  const raw = input.trim();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Enter a full URL, e.g. http://127.0.0.1:18090");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("The server URL must start with http:// or https://");
  if (u.username || u.password) throw new Error("The server URL must not contain credentials");
  if (u.search || u.hash) throw new Error("The server URL must not contain a query or fragment");
  return (u.origin + u.pathname).replace(/\/+$/, "");
}

/** Picks the effective server URL: env, then the saved setting, then the default. */
export function resolveServerUrl(env: string | undefined, saved: string | undefined): string {
  for (const candidate of [env, saved]) {
    if (!candidate) continue;
    try {
      return normalizeServerUrl(candidate);
    } catch {
      // Ignore an invalid value and fall through.
    }
  }
  return DEFAULT_SERVER_URL;
}

/**
 * The renderer CSP. connect-src is limited to the configured server origin
 * (http and the matching ws scheme). In dev, the Vite dev server origin is
 * added and inline scripts are allowed for React refresh.
 */
export function buildCsp(serverUrl: string, devServerUrl?: string): string {
  const server = new URL(serverUrl);
  const ws = `${server.protocol === "https:" ? "wss:" : "ws:"}//${server.host}`;
  const connect = [server.origin, ws];
  const script = ["'self'"];
  if (devServerUrl) {
    const dev = new URL(devServerUrl);
    connect.push(dev.origin, `ws://${dev.host}`);
    script.push("'unsafe-inline'");
  }
  return [
    "default-src 'none'",
    `script-src ${script.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${server.origin}`,
    "font-src 'self' data:",
    `connect-src ${connect.join(" ")}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

/** URLs we are willing to hand to the OS browser. */
export function isExternalUrlAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:";
  } catch {
    return false;
  }
}
