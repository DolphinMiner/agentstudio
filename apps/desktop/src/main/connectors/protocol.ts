// Agent side of the AgentStudio Agent Protocol (docs/agent-protocol.md), for the
// connectors that run inside the desktop app. Kept dependency-free so the e2e
// fakes can import it too.

export const PROTOCOL_VERSION = "agentstudio-agent/0";

export type Capability = "chat" | "ask" | "approvals";

export type AgentInfo = {
  name: string;
  description?: string;
  avatar_url?: string;
  capabilities: Capability[];
  protocol: typeof PROTOCOL_VERSION;
};

export type AskLine = { speaker: string; own: boolean; ts: number; text: string };
export type Ask = { task_id: string; app: string; chat: string; request: string; lines: AskLine[] };

export type InboundMessage = {
  session_id: string;
  message_id: string;
  text: string;
  sent_at: string;
  ask?: Ask;
};

export type Attachment = { url: string; name?: string; mime_type?: string };

/** How many messages a connector imports from the conversation when it first connects. */
export const HISTORY_ON_CONNECT = 20;

export type Choice = { key: string; label: string; category: "approve" | "deny" };
export type Detail = { label: string; value: string };

export type AgentEvent =
  | {
      type: "message";
      text: string;
      reply_to?: string;
      /** Files to post along (the bridge downloads them; images show inline). */
      attachments?: Attachment[];
      /** Something the user said in the service's own app (via names it). */
      from_user?: boolean;
      via?: string;
      /** Earlier conversation imported on connect, sent at ts (RFC 3339): no notifications. */
      history?: boolean;
      ts?: string;
    }
  | { type: "drafts"; task_id: string; drafts: { text: string }[]; text?: string }
  | {
      type: "approval_request";
      external_id: string;
      title: string;
      summary?: string;
      details?: Detail[];
      choices: Choice[];
      expires_in_seconds?: number;
    }
  | { type: "approval_cancel"; external_id: string }
  | { type: "status"; state: "idle" | "working"; text?: string }
  | { type: "profile"; name?: string; avatar_url?: string };

export const MAX_TEXT = 20000;

export function truncate(s: string, n: number): string {
  const chars = [...s];
  return chars.length <= n ? s : chars.slice(0, n - 1).join("") + "…";
}

/**
 * Turns an "Ask an agent" payload into a plain prompt for agents that don't
 * know about asks. Mirrors server/internal/agenthost/ask.go.
 */
export function askPrompt(ask: Ask): string {
  const request = ask.request.trim() || "Draft a reply";
  let s = `${request} for this conversation`;
  if (ask.chat) s += ` with ${ask.chat}`;
  if (ask.app) s += ` on ${ask.app}`;
  s += ":\n\n";
  for (const l of ask.lines) s += `${l.speaker}: ${l.text}\n`;
  s += "\nWrite 3 short reply options I could send, as a numbered list (1., 2., 3.), with no other text.";
  return s;
}

const DRAFT_LINE = /^\s*(?:\d+[.)]|[-*•])\s+(.+?)\s*$/;

/** Numbered or bulleted lines as drafts; otherwise the whole answer as one draft. */
export function parseDrafts(answer: string): string[] {
  const drafts: string[] = [];
  for (const line of answer.split("\n")) {
    const m = DRAFT_LINE.exec(line);
    const d = m?.[1]?.replace(/^["“”]+|["“”]+$/g, "").trim();
    if (d) drafts.push(d);
  }
  if (drafts.length === 0 && answer.trim()) drafts.push(answer.trim());
  return drafts.slice(0, 5);
}
