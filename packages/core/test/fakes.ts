// Test fakes: a scripted fetch, and Matrix rooms/events shaped like RoomLike.

import type { FetchInit, FetchLike, ResponseLike } from "../src/platform.js";
import type { EventLike, MemberLike, RoomLike } from "../src/matrix.js";
import type { Agent, Approval, Session, Task } from "../src/types.js";

export type Call = { method: string; path: string; body: any; auth: string | undefined };
export type Handler = (call: Call) => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }>;

export function fakeFetch(handler: Handler): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url: string, init?: FetchInit): Promise<ResponseLike> => {
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.replace(/^https?:\/\/[^/]+/, ""),
      body: init?.body ? JSON.parse(init.body) : undefined,
      auth: init?.headers?.["Authorization"],
    };
    calls.push(call);
    const r = await handler(call);
    const text = r.body === undefined ? "" : JSON.stringify(r.body);
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: { get: () => null },
      text: async () => text,
    };
  };
  return { fetch, calls };
}

export function makeSession(n: number, opts: { expiresInMs?: number; now?: number } = {}): Session {
  const now = opts.now ?? Date.now();
  return {
    session_id: "ses_1",
    access_token: `at${n}`,
    access_expires_at: new Date(now + (opts.expiresInMs ?? 15 * 60_000)).toISOString(),
    refresh_token: `rt${n}`,
    user: { id: "usr_1", email: "a@example.com", matrix_user_id: ME, created_at: "2026-01-01T00:00:00Z" },
    matrix: { homeserver_url: "http://127.0.0.1:18090", user_id: ME, device_id: "DEV", access_token: "mx" },
  };
}

export const ME = "@u_1:agentstudio.local";

export type FakeEventInit = {
  id?: string;
  type?: string;
  sender: string;
  senderName?: string;
  content?: Record<string, unknown>;
  body?: string;
  ts: number;
  status?: string | null;
  redacted?: boolean;
  stateKey?: string;
};

let seq = 0;
export function ev(init: FakeEventInit): EventLike {
  const id = init.id ?? `$e${++seq}`;
  const content = init.content ?? { msgtype: "m.text", body: init.body ?? "" };
  return {
    getId: () => id,
    getType: () => init.type ?? "m.room.message",
    getSender: () => init.sender,
    getContent: () => content,
    getTs: () => init.ts,
    isRedacted: () => init.redacted ?? false,
    status: init.status ?? null,
    sender: init.senderName ? { name: init.senderName } : null,
  };
}

export type FakeRoomInit = {
  roomId: string;
  name: string;
  membership?: string;
  bridge?: { id: string; displayname?: string; type?: "m.bridge" | "uk.half-shot.bridge" };
  members?: MemberLike[];
  events?: EventLike[];
  readUpTo?: string | null;
};

export function room(init: FakeRoomInit): RoomLike & { events: EventLike[] } {
  const events = init.events ?? [];
  const members: MemberLike[] = [{ userId: ME, name: "Me", membership: "join" }, ...(init.members ?? [])];
  const state: Record<string, EventLike[]> = {};
  if (init.bridge) {
    state[init.bridge.type ?? "m.bridge"] = [
      ev({
        type: init.bridge.type ?? "m.bridge",
        sender: "@demobot:agentstudio.local",
        ts: 0,
        content: {
          bridgebot: "@demobot:agentstudio.local",
          protocol: { id: init.bridge.id, displayname: init.bridge.displayname },
        },
      }),
    ];
  }
  return {
    roomId: init.roomId,
    name: init.name,
    events,
    getMyMembership: () => init.membership ?? "join",
    currentState: { getStateEvents: (type: string) => state[type] ?? [] },
    getLiveTimeline: () => ({ getEvents: () => events }),
    getMembers: () => members,
    getMember: (id: string) => members.find((m) => m.userId === id) ?? null,
    getEventReadUpTo: () => init.readUpTo ?? null,
  };
}

export function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: "agentstudio-agents:concierge",
    connection_id: "agentstudio-agents:concierge",
    name: "Concierge",
    room_id: "!agent:agentstudio.local",
    capabilities: ["chat", "ask", "approvals"],
    status: "idle",
    pending_approvals: 0,
    consent: { ask_without_preview: false },
    ...over,
  };
}

export function approval(over: Partial<Approval> = {}): Approval {
  return {
    id: "apr_1",
    version: 1,
    agent_id: "agentstudio-agents:concierge",
    agent_name: "Concierge",
    room_id: "!agent:agentstudio.local",
    event_id: "$card",
    title: "Book the 6pm flight to Toronto for $412?",
    details: [{ label: "Price", value: "$412" }],
    choices: [
      { key: "book", label: "Book", category: "approve" },
      { key: "skip", label: "Don't book", category: "deny" },
    ],
    state: "pending",
    decision: null,
    delivery_state: null,
    expires_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

export function task(over: Partial<Task> = {}): Task {
  return {
    id: "tsk_1",
    version: 1,
    agent_id: "agentstudio-agents:concierge",
    agent_name: "Concierge",
    state: "answered",
    title: "Are we still on for 7:15?",
    request_text: "Draft a reply",
    origin: { room_id: "!leo:agentstudio.local", network: "demo", chat_name: "Leo Park", anchor_event_id: "$a" },
    answer: { event_id: "$d", drafts: [{ text: "Yes!" }] },
    sent_draft_index: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

export function err(status: number, code: string, current?: unknown) {
  return { status, body: { error: { code, message: code, ...(current ? { current } : {}) } } };
}

export const sleep = (ms: number) =>
  new Promise<void>((r) => (globalThis as unknown as { setTimeout(f: () => void, ms: number): void }).setTimeout(r, ms));
