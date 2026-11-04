// AgentStudio custom content keys on m.room.message (docs/matrix-events.md).

export const ASK_KEY = "com.agentstudio.ask";
export const DRAFTS_KEY = "com.agentstudio.drafts";
export const APPROVAL_KEY = "com.agentstudio.approval";

export const NETWORK_AGENTS = "agentstudio-agents";
export const NETWORK_DEMO = "demo";
export const NETWORK_MATRIX = "matrix";

/** Ghost localpart prefixes of our bridges (bridgev2 username_template). */
export const GHOST_PREFIXES = ["demo_", "agents_"] as const;

export type AskLine = { speaker: string; own: boolean; ts: number; text: string };

export type AskPayload = {
  v: 1;
  task_id: string;
  app: string;
  chat: string;
  request: string;
  lines: AskLine[];
};

export type DraftsPayload = { v: 1; task_id: string; drafts: { text: string }[] };

export type ApprovalPayload = { v: 1; approval_id: string };

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}

export function parseAsk(content: unknown): AskPayload | null {
  const p = obj(obj(content)?.[ASK_KEY]);
  if (!p || typeof p.task_id !== "string") return null;
  const lines = Array.isArray(p.lines)
    ? p.lines.flatMap((l): AskLine[] => {
        const o = obj(l);
        if (!o || typeof o.text !== "string") return [];
        return [
          {
            speaker: typeof o.speaker === "string" ? o.speaker : "",
            own: o.own === true,
            ts: typeof o.ts === "number" ? o.ts : 0,
            text: o.text,
          },
        ];
      })
    : [];
  return {
    v: 1,
    task_id: p.task_id,
    app: typeof p.app === "string" ? p.app : "",
    chat: typeof p.chat === "string" ? p.chat : "",
    request: typeof p.request === "string" ? p.request : "",
    lines,
  };
}

export function parseDrafts(content: unknown): DraftsPayload | null {
  const p = obj(obj(content)?.[DRAFTS_KEY]);
  if (!p || typeof p.task_id !== "string" || !Array.isArray(p.drafts)) return null;
  const drafts = p.drafts.flatMap((d) => {
    const o = obj(d);
    return o && typeof o.text === "string" ? [{ text: o.text }] : [];
  });
  return { v: 1, task_id: p.task_id, drafts };
}

export function parseApproval(content: unknown): ApprovalPayload | null {
  const p = obj(obj(content)?.[APPROVAL_KEY]);
  if (!p || typeof p.approval_id !== "string") return null;
  return { v: 1, approval_id: p.approval_id };
}

/** Split "@local:server" into parts. Returns null for malformed ids. */
export function parseMxid(mxid: string): { localpart: string; server: string } | null {
  const m = /^@([^:]+):(.+)$/.exec(mxid);
  return m ? { localpart: m[1]!, server: m[2]! } : null;
}

/** A bridge bot on our homeserver, e.g. @demobot:agentstudio.local. */
export function isBridgeBot(mxid: string, serverName: string): boolean {
  const p = parseMxid(mxid);
  return !!p && p.server === serverName && p.localpart.endsWith("bot");
}

/** A bridge ghost on our homeserver, e.g. @demo_mom:agentstudio.local. */
export function isBridgeGhost(mxid: string, serverName: string): boolean {
  const p = parseMxid(mxid);
  return !!p && p.server === serverName && GHOST_PREFIXES.some((g) => p.localpart.startsWith(g));
}

/**
 * Auto-join policy: accept invites only from bridge bots and ghosts on our
 * own homeserver (docs/matrix-events.md).
 */
export function shouldAutoJoin(inviter: string | null | undefined, serverName: string): boolean {
  if (!inviter) return false;
  return isBridgeBot(inviter, serverName) || isBridgeGhost(inviter, serverName);
}
