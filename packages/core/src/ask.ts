// "Ask an agent": quote building (with anonymization and limits) and the
// com.agentstudio.ask message content (docs/matrix-events.md).

import { ASK_KEY, type AskLine, type AskPayload } from "./events.js";
import type { SendResult } from "./matrix.js";
import type { Agent, Task, TaskOrigin } from "./types.js";

export const ASK_MAX_LINES = 5; // anchor + 4 prior
export const ASK_MAX_CHARS = 2000;
export const ASK_MAX_GAP_MS = 10 * 60_000;
export const DEFAULT_ASK_REQUEST = "Draft a reply";

/** The subset of ChatMessage the quote needs. */
export type AskSourceMessage = {
  sender: string;
  senderName: string;
  own: boolean;
  body: string;
  ts: number;
};

export type AskQuoteOptions = {
  maxLines?: number;
  maxChars?: number;
  /** Stop walking back at a gap larger than this between messages. */
  maxGapMs?: number;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[\d\s().\-]+$/;

/** True for a display name that is just a phone number or an email address. */
export function isContactAddressOnly(name: string): boolean {
  const n = name.trim();
  if (EMAIL_RE.test(n)) return true;
  if (PHONE_RE.test(n)) return (n.match(/\d/g)?.length ?? 0) >= 5;
  return false;
}

function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

/**
 * Build the quoted context for an ask: the anchor message plus up to 4 prior
 * messages, oldest first. Walking back stops at a gap > 10 minutes. Senders
 * known only by phone/email become "Person 1", "Person 2", ... (numbered in
 * order of appearance); the user's own lines are "Me".
 */
export function buildAskQuote(
  messages: readonly AskSourceMessage[],
  anchorIndex: number,
  opts: AskQuoteOptions = {},
): AskLine[] {
  const maxLines = opts.maxLines ?? ASK_MAX_LINES;
  const maxChars = opts.maxChars ?? ASK_MAX_CHARS;
  const maxGap = opts.maxGapMs ?? ASK_MAX_GAP_MS;
  const anchor = messages[anchorIndex];
  if (!anchor) return [];

  const picked: AskSourceMessage[] = [anchor];
  let newerTs = anchor.ts;
  for (let i = anchorIndex - 1; i >= 0 && picked.length < maxLines; i--) {
    const m = messages[i]!;
    if (newerTs - m.ts > maxGap) break;
    newerTs = m.ts;
    if (!m.body.trim()) continue;
    picked.unshift(m);
  }

  const people = new Map<string, string>();
  return picked.map((m) => {
    let speaker: string;
    if (m.own) speaker = "Me";
    else if (isContactAddressOnly(m.senderName)) {
      let p = people.get(m.sender);
      if (!p) {
        p = `Person ${people.size + 1}`;
        people.set(m.sender, p);
      }
      speaker = p;
    } else speaker = m.senderName;
    return { speaker, own: m.own, ts: m.ts, text: cap(m.body, maxChars) };
  });
}

export type AskContentInput = {
  task_id: string;
  /** Network label of the origin chat, e.g. "Demo". */
  app: string;
  /** Origin chat name, e.g. "Leo Park". */
  chat: string;
  request: string;
};

export type AskContent = {
  msgtype: "m.text";
  body: string;
  [ASK_KEY]: AskPayload;
};

/** The exact m.room.message content for an ask, with a readable body fallback. */
export function buildAskContent(task: AskContentInput, lines: readonly AskLine[]): AskContent {
  const request = task.request.trim() || DEFAULT_ASK_REQUEST;
  let body = `Ask: ${request}`;
  if (lines.length > 0) {
    const quoted = lines.map((l) => `> ${l.speaker}: ${l.text.replace(/\n/g, "\n> ")}`);
    body += `\n\nFrom ${task.chat} in ${task.app}:\n${quoted.join("\n")}`;
  }
  return {
    msgtype: "m.text",
    body,
    [ASK_KEY]: {
      v: 1,
      task_id: task.task_id,
      app: task.app,
      chat: task.chat,
      request,
      lines: lines.slice(-ASK_MAX_LINES).map((l) => ({ ...l })),
    },
  };
}

export type AskAgentDeps = {
  tasks: {
    create(agentId: string, requestText: string, origin: TaskOrigin, title?: string): Promise<Task>;
  };
  matrix: { sendContent(roomId: string, content: Record<string, unknown>): Promise<SendResult> };
};

export type AskAgentInput = {
  agent: Pick<Agent, "id" | "room_id">;
  request: string;
  origin: TaskOrigin;
  /** Network label of the origin chat, e.g. "Demo". */
  app: string;
  lines: readonly AskLine[];
  /** Anchor message text, used as the task title (defaults to the last line). */
  title?: string;
};

/**
 * Full "Ask an agent" flow: create the task via REST, then send the ask
 * message into the agent's room. The app then navigates to the agent chat.
 */
export async function askAgent(
  deps: AskAgentDeps,
  input: AskAgentInput,
): Promise<{ task: Task; send: SendResult }> {
  const roomId = input.agent.room_id;
  if (!roomId) throw new Error("Agent has no room yet");
  const request = input.request.trim() || DEFAULT_ASK_REQUEST;
  const title = input.title ?? input.lines.at(-1)?.text;
  const task = await deps.tasks.create(input.agent.id, request, input.origin, title);
  const content = buildAskContent(
    { task_id: task.id, app: input.app, chat: input.origin.chat_name, request },
    input.lines,
  );
  const send = await deps.matrix.sendContent(roomId, content);
  return { task, send };
}
