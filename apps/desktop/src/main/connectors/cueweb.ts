// Signing in to Cue with the user's Manus account, the way the Cue desktop app
// does: manus.im/login runs in the user's browser (Google and Apple refuse
// sign-in inside embedded windows), and the page hands a session token back on
// a cuedev:// link, which a small helper app catches for AgentStudio (see
// ensureLinkCatcher). The Cue app doesn't need to be installed. With the session AgentStudio creates a Manus
// API key named "AgentStudio", which the connector then uses with the documented
// API. Only that one call uses Manus's internal API.

import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CUE_SCHEME as SCHEME, callbackToken } from "./cue";

export type CueWebConfig = {
  /** manus.im: the sign-in pages. */
  webUrl: string;
  /** api.manus.im: Manus's own Connect RPC API (the API-key call). */
  rpcUrl: string;
};

/** Sign-ins waiting for their callback link, by nonce. */
const waiting = new Map<string, (url: string) => void>();

/**
 * Hands a cuedev:// link to the sign-in waiting for it (from the link catcher,
 * a test window, or app "open-url"). Returns true when it was one.
 */
export function handleCueLink(url: string): boolean {
  if (!url.startsWith(`${SCHEME}:`)) return false;
  for (const [nonce, deliver] of waiting) {
    if (callbackToken(url, nonce)) {
      deliver(url);
      return true;
    }
  }
  return true;
}

const LS_REGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const CATCHER_ID = "org.agentstudio.link-catcher";
const CATCHER_VERSION = "3"; // 3: bundle id org.agentstudio.link-catcher

/**
 * A tiny AppleScript app that claims cuedev:// and writes each link it gets to
 * a file AgentStudio reads. AgentStudio can't claim the scheme itself: unpackaged
 * Electron shares one bundle id between every copy on the Mac, so macOS may
 * hand the link to another one. Built once (osacompile) into userData.
 */
export async function ensureLinkCatcher(dir: string): Promise<{ inbox: string }> {
  const appPath = join(dir, "AgentStudio Link Catcher.app");
  const inbox = join(dir, "inbox.txt");
  const stamp = join(dir, "version");
  const current = existsSync(stamp) ? readFileSync(stamp, "utf8") : "";
  if (current !== CATCHER_VERSION || !existsSync(appPath)) {
    rmSync(appPath, { recursive: true, force: true });
    // Earlier catchers under another name share the bundle id and write elsewhere: remove them.
    for (const old of existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(" Link Catcher.app")) : []) {
      await run(LS_REGISTER, ["-u", join(dir, old)]).catch(() => {});
      rmSync(join(dir, old), { recursive: true, force: true });
    }
    mkdirSync(dir, { recursive: true });
    const script = join(dir, "catcher.applescript");
    const quoted = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    writeFileSync(
      script,
      `on open location theURL\n\tdo shell script "printf %s " & quoted form of theURL & " > " & quoted form of ${quoted(inbox)}\nend open location\n`,
    );
    await run("osacompile", ["-o", appPath, script]);
    const plist = join(appPath, "Contents", "Info.plist");
    const pb = (...cmds: string[]) => run("/usr/libexec/PlistBuddy", [...cmds.flatMap((c) => ["-c", c]), plist]);
    await pb("Delete :CFBundleIdentifier").catch(() => {});
    await pb(
      `Add :CFBundleIdentifier string ${CATCHER_ID}`,
      "Add :LSUIElement bool true",
      "Add :CFBundleURLTypes array",
      "Add :CFBundleURLTypes:0 dict",
      "Add :CFBundleURLTypes:0:CFBundleURLName string AgentStudio sign-in",
      "Add :CFBundleURLTypes:0:CFBundleURLSchemes array",
      `Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string ${SCHEME}`,
    );
    await run("codesign", ["-f", "-s", "-", appPath]);
    writeFileSync(stamp, CATCHER_VERSION);
  }
  await run(LS_REGISTER, ["-f", appPath]);
  // Make it the handler, even if something else claimed the scheme before.
  await run("osascript", [
    "-l",
    "JavaScript",
    "-e",
    `ObjC.import("CoreServices"); $.LSSetDefaultHandlerForURLScheme($("${SCHEME}"), $("${CATCHER_ID}"))`,
  ]);
  return { inbox };
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30_000 }, (err, _out, stderr) => (err ? reject(new Error(`${cmd}: ${stderr || err.message}`)) : resolve()));
  });
}

/** Reads links the catcher writes, until stopped. */
function watchInbox(inbox: string): () => void {
  rmSync(inbox, { force: true });
  const t = setInterval(() => {
    if (!existsSync(inbox)) return;
    const url = readFileSync(inbox, "utf8").trim();
    rmSync(inbox, { force: true });
    if (url) handleCueLink(url);
  }, 400);
  return () => clearInterval(t);
}

/** The Manus sign-in page for a nonce. */
export function signInUrl(cfg: CueWebConfig, nonce: string): string {
  const login = new URL(`${cfg.webUrl}/login`);
  const back = new URL(`${cfg.webUrl}/login-success`);
  back.searchParams.set("desktopAgents", "1");
  back.searchParams.set("agentsScheme", SCHEME);
  back.searchParams.set("nonce", nonce);
  for (const [k, v] of [["from", "desktop"], ["type", "signIn"], ["desktopAgents", "1"], ["nonce", nonce], ["redirectUrl", back.href]]) {
    login.searchParams.set(k!, v!);
  }
  return login.href;
}

/**
 * Opens Manus sign-in (with openExternal: the browser, or a test window) and
 * resolves with the session token once the callback link arrives.
 */
export async function cueWebSignIn(
  cfg: CueWebConfig,
  openExternal: (url: string) => Promise<void>,
  signal: AbortSignal,
  /** Where to keep the link catcher; null when sign-in runs in an AgentStudio window (tests). */
  catcherDir: string | null,
): Promise<string> {
  const nonce = randomBytes(32).toString("hex");
  const stop = catcherDir ? watchInbox((await ensureLinkCatcher(catcherDir)).inbox) : () => {};
  try {
    return await new Promise<string>((resolve, reject) => {
      const onAbort = () => reject(new Error("cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
      waiting.set(nonce, (url) => {
        const r = callbackToken(url, nonce);
        if (r && "token" in r) resolve(r.token);
        else reject(new Error("Signing in to Manus wasn't completed."));
      });
      openExternal(signInUrl(cfg, nonce)).catch(reject);
      // The browser may ask "Open AgentStudio?"; the user has the whole sign-in window to answer.
      setTimeout(() => reject(new Error("Signing in timed out.")), 15 * 60_000);
    });
  } finally {
    waiting.delete(nonce);
    stop();
  }
}

/** Creates a Manus API key with a signed-in session. */
export async function createCueApiKey(cfg: CueWebConfig, sessionToken: string): Promise<string> {
  const res = await fetch(`${cfg.rpcUrl}/openapi.v1.OpenapiService/CreateAPIKey`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "connect-protocol-version": "1",
      authorization: `Bearer ${sessionToken}`,
      "x-client-type": "web",
    },
    body: JSON.stringify({ name: `AgentStudio (${new Date().toISOString().slice(0, 10)})` }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as { apiKeyData?: { apiKey?: string }; message?: string };
  const key = body.apiKeyData?.apiKey;
  if (!res.ok || !key) throw new Error(body.message ? `Manus: ${body.message}` : `Couldn't create a Manus API key (HTTP ${res.status})`);
  return key;
}
