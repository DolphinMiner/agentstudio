// Inbox model: ChatRow[] derived from Matrix rooms plus the agents list.

import { NETWORK_AGENTS } from "./events.js";
import {
  classifyRoom,
  roomDisplayName,
  toChatMessage,
  unreadCount,
  type RoomLike,
} from "./matrix.js";
import { ChangeEmitter, type ReadableStore, type VersionedSource } from "./store.js";
import type { Agent, AgentStatus } from "./types.js";

export type InboxFilter = "all" | "people" | "agents";

export type ChatRow = {
  roomId: string;
  name: string;
  network: string; // "demo", "agentstudio-agents", "matrix", ...
  networkLabel: string; // "Demo", "Agent", ...
  lastMessage: string | null; // preview text
  lastSender: string | null; // display name of the last message's sender
  lastOwn: boolean;
  lastTs: number;
  unread: number;
  isAgent: boolean;
  agentId: string | null;
  agentStatus: AgentStatus | null;
  agentStatusText: string | null;
  needsYou: boolean; // the agent has pending approvals
};

const PREVIEW_MAX = 140;

function preview(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > PREVIEW_MAX ? oneLine.slice(0, PREVIEW_MAX - 1) + "…" : oneLine;
}

export function deriveChatRow(room: RoomLike, myUserId: string, agents: readonly Agent[]): ChatRow | null {
  const cls = classifyRoom(room, myUserId);
  if (cls.hidden) return null;
  const events = room.getLiveTimeline().getEvents();
  let lastTs = 0;
  let last = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (!lastTs) lastTs = ev.getTs();
    const m = toChatMessage(ev, room, myUserId);
    if (m) {
      last = m;
      lastTs = Math.max(lastTs, m.ts);
      break;
    }
  }
  const agent = cls.isAgentRoom ? (agents.find((a) => a.room_id === room.roomId) ?? null) : null;
  return {
    roomId: room.roomId,
    name: agent?.name ?? roomDisplayName(room, myUserId),
    network: cls.network,
    networkLabel: cls.networkLabel,
    lastMessage: last ? preview(last.body) : null,
    lastSender: last ? (last.own ? "Me" : last.senderName) : null,
    lastOwn: last?.own ?? false,
    lastTs,
    unread: unreadCount(room, myUserId),
    isAgent: cls.isAgentRoom,
    agentId: agent?.id ?? null,
    agentStatus: agent?.status ?? null,
    agentStatusText: agent ? (agent.status_text ?? null) : null,
    needsYou: (agent?.pending_approvals ?? 0) > 0,
  };
}

/** All visible rows, most recent activity first. */
export function deriveChatRows(
  rooms: readonly RoomLike[],
  myUserId: string,
  agents: readonly Agent[],
): ChatRow[] {
  const rows: ChatRow[] = [];
  for (const r of rooms) {
    const row = deriveChatRow(r, myUserId, agents);
    if (row) rows.push(row);
  }
  return rows.sort((a, b) => b.lastTs - a.lastTs || a.name.localeCompare(b.name));
}

export function filterChatRows(rows: readonly ChatRow[], filter: InboxFilter): ChatRow[] {
  if (filter === "agents") return rows.filter((r) => r.isAgent);
  if (filter === "people") return rows.filter((r) => !r.isAgent);
  return [...rows];
}

export function isAgentNetwork(network: string): boolean {
  return network === NETWORK_AGENTS;
}

export interface InboxSources {
  matrix: VersionedSource & { getRooms(): readonly RoomLike[]; readonly userId: string };
  agents: { subscribe(l: () => void): () => void; getSnapshot(): { items: Agent[] } };
}

/**
 * Observable inbox: `rows` updates when Matrix or the agents list change.
 * Use with useSyncExternalStore(inbox.rows.subscribe, inbox.rows.getSnapshot).
 */
export class InboxStore {
  readonly rows: ReadableStore<ChatRow[]>;
  private readonly changes = new ChangeEmitter();
  private readonly unsubs: (() => void)[] = [];

  constructor(private readonly src: InboxSources) {
    this.unsubs.push(src.matrix.subscribe(() => this.changes.emit()));
    this.unsubs.push(src.agents.subscribe(() => this.changes.emit()));
    // Recompute when either the Matrix version or the agents snapshot changed.
    let seenVersion = -1;
    let seenAgents: Agent[] | null = null;
    let cached: ChatRow[] = [];
    this.rows = {
      subscribe: (l) => this.changes.subscribe(l),
      getSnapshot: () => {
        const v = src.matrix.version();
        const agents = src.agents.getSnapshot().items;
        if (v !== seenVersion || agents !== seenAgents) {
          cached = deriveChatRows(src.matrix.getRooms(), src.matrix.userId, agents);
          seenVersion = v;
          seenAgents = agents;
        }
        return cached;
      },
    };
  }

  /** Filtered rows; the result is cached per filter until the next change. */
  filtered(filter: InboxFilter): ChatRow[] {
    const rows = this.rows.getSnapshot();
    const hit = this.cache.get(filter);
    if (hit && hit.from === rows) return hit.rows;
    const out = filterChatRows(rows, filter);
    this.cache.set(filter, { from: rows, rows: out });
    return out;
  }
  private cache = new Map<InboxFilter, { from: ChatRow[]; rows: ChatRow[] }>();

  dispose(): void {
    for (const u of this.unsubs.splice(0)) u();
  }
}
