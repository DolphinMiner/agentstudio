// Matrix side of @agentstudio/core: room classification, the message model, and a
// thin wrapper around a matrix-js-sdk client (start/stop, auto-join, sending
// with optimistic status, read receipts, change notifications).
//
// The pure helpers take small structural interfaces (RoomLike, EventLike) that
// matrix-js-sdk's Room and MatrixEvent satisfy, so they can be unit tested
// with plain fakes.

import {
  ClientEvent,
  EventStatus,
  ReceiptType,
  RoomEvent,
  RoomMemberEvent,
  RoomStateEvent,
  SyncState,
  createClient,
  type ICreateClientOpts,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from "matrix-js-sdk";
import {
  APPROVAL_KEY,
  ASK_KEY,
  DRAFTS_KEY,
  NETWORK_AGENTS,
  NETWORK_MATRIX,
  isBridgeBot,
  parseApproval,
  parseAsk,
  parseDrafts,
  parseMxid,
  shouldAutoJoin,
  type ApprovalPayload,
  type AskPayload,
  type DraftsPayload,
} from "./events.js";
import {
  ChangeEmitter,
  derived,
  type Listener,
  type ReadableStore,
  type Unsubscribe,
  type VersionedSource,
} from "./store.js";
import type { LiveMessageListener } from "./notifications.js";
import type { MatrixCredentials } from "./types.js";

// ---- structural views of matrix-js-sdk objects ------------------------------

export interface EventLike {
  getId(): string | undefined;
  getType(): string;
  getSender(): string | undefined;
  getContent(): object;
  getTs(): number;
  isRedacted(): boolean;
  readonly status: string | null;
  readonly sender: { name: string } | null;
}

export interface MemberLike {
  readonly userId: string;
  readonly name: string;
  readonly membership?: string;
}

export interface RoomLike {
  readonly roomId: string;
  readonly name: string;
  getMyMembership(): string;
  readonly currentState: { getStateEvents(type: string): EventLike[] };
  getLiveTimeline(): { getEvents(): EventLike[] };
  getMembers(): MemberLike[];
  getMember(userId: string): MemberLike | null;
  getEventReadUpTo(userId: string): string | null;
}

// ---- room classification -----------------------------------------------------

export const BRIDGE_STATE_TYPES = ["m.bridge", "uk.half-shot.bridge"] as const;

export type BridgeInfo = { protocolId: string; protocolName: string | null; bot: string | null };

/** Reads the bridgev2 bridge info state (m.bridge or uk.half-shot.bridge). */
export function getBridgeInfo(room: RoomLike): BridgeInfo | null {
  for (const type of BRIDGE_STATE_TYPES) {
    for (const ev of room.currentState.getStateEvents(type) ?? []) {
      const c = ev.getContent() as {
        protocol?: { id?: unknown; displayname?: unknown };
        bridgebot?: unknown;
      };
      if (typeof c?.protocol?.id === "string" && c.protocol.id) {
        return {
          protocolId: c.protocol.id,
          protocolName: typeof c.protocol.displayname === "string" ? c.protocol.displayname : null,
          bot: typeof c.bridgebot === "string" ? c.bridgebot : null,
        };
      }
    }
  }
  return null;
}

/** Human label for a network as shown in rows and headers ("Demo", "Agent"). */
export function networkLabel(networkId: string, displayName?: string | null): string {
  if (networkId === NETWORK_AGENTS) return "Agent";
  if (networkId === NETWORK_MATRIX) return "Matrix";
  if (displayName) return displayName;
  return networkId.charAt(0).toUpperCase() + networkId.slice(1);
}

export type RoomClass = {
  network: string; // "demo" | "agentstudio-agents" | "matrix" | ...
  networkLabel: string; // "Demo" | "Agent" | ...
  isAgentRoom: boolean;
  /** Management room with a bridge bot: hidden from the inbox. */
  isManagement: boolean;
  /** Not shown in the inbox (management room, or not joined). */
  hidden: boolean;
};

function otherMembers(room: RoomLike, myUserId: string): MemberLike[] {
  return room
    .getMembers()
    .filter(
      (m) => m.userId !== myUserId && (m.membership === "join" || m.membership === "invite"),
    );
}

export function classifyRoom(room: RoomLike, myUserId: string): RoomClass {
  const serverName = parseMxid(myUserId)?.server ?? "";
  const info = getBridgeInfo(room);
  const network = info?.protocolId ?? NETWORK_MATRIX;
  let isManagement = false;
  if (!info) {
    const others = otherMembers(room, myUserId);
    isManagement = others.length > 0 && others.every((m) => isBridgeBot(m.userId, serverName));
  }
  return {
    network,
    networkLabel: networkLabel(network, info?.protocolName),
    isAgentRoom: network === NETWORK_AGENTS,
    isManagement,
    hidden: isManagement || room.getMyMembership() !== "join",
  };
}

/** Display name for a room; falls back to the first non-bot member. */
export function roomDisplayName(room: RoomLike, myUserId: string): string {
  const n = room.name?.trim();
  if (n && !/^Empty room/i.test(n)) return n;
  const serverName = parseMxid(myUserId)?.server ?? "";
  const other = otherMembers(room, myUserId).find((m) => !isBridgeBot(m.userId, serverName));
  return other?.name || n || room.roomId;
}

// ---- message model -----------------------------------------------------------

export type MessageStatus = "sending" | "sent" | "failed";

export type ChatMessage = {
  /** Event id; for local echoes, the SDK's temporary id until sent. */
  id: string;
  roomId: string;
  sender: string;
  senderName: string;
  own: boolean;
  msgtype: string;
  body: string;
  ts: number;
  status: MessageStatus;
  ask: AskPayload | null;
  drafts: DraftsPayload | null;
  approval: ApprovalPayload | null;
  /** The service's own app, for what the user said there (own is true). */
  via: string | null;
  /** Earlier conversation imported on connect. */
  history: boolean;
  /** For m.image / m.file: the file (fetch it with mediaRequest). */
  file: { mxc: string; name: string; mime: string; size: number | null } | null;
};

/** What the user said in a service's own app, relayed by a bridge (docs/matrix-events.md). */
export function isFromUser(content: Record<string, unknown>): boolean {
  return content["com.agentstudio.from_user"] === true;
}

/** Earlier conversation a bridge imported on connect. */
export function isHistory(content: Record<string, unknown>): boolean {
  return content["com.agentstudio.history"] === true;
}

function fileOf(content: Record<string, unknown>): ChatMessage["file"] {
  if (content.msgtype !== "m.image" && content.msgtype !== "m.file") return null;
  const url = typeof content.url === "string" ? content.url : null;
  if (!url?.startsWith("mxc://")) return null;
  const info = (content.info ?? {}) as { mimetype?: unknown; size?: unknown };
  const name = typeof content.filename === "string" ? content.filename : typeof content.body === "string" ? content.body : "file";
  return { mxc: url, name, mime: typeof info.mimetype === "string" ? info.mimetype : "", size: typeof info.size === "number" ? info.size : null };
}

export function mapStatus(status: string | null): MessageStatus {
  switch (status) {
    case null:
    case undefined:
    case EventStatus.SENT:
      return "sent";
    case EventStatus.NOT_SENT:
    case EventStatus.CANCELLED:
      return "failed";
    default:
      return "sending";
  }
}

/** Maps an m.room.message event to the client model; other events give null. */
export function toChatMessage(ev: EventLike, room: RoomLike, myUserId: string): ChatMessage | null {
  if (ev.getType() !== "m.room.message" || ev.isRedacted()) return null;
  const content = ev.getContent() as { body?: unknown; msgtype?: unknown } & Record<string, unknown>;
  const sender = ev.getSender() ?? "";
  const id = ev.getId();
  if (!id) return null;
  const fromUser = isFromUser(content);
  return {
    id,
    roomId: room.roomId,
    sender,
    senderName: ev.sender?.name || room.getMember(sender)?.name || sender,
    own: sender === myUserId || fromUser,
    msgtype: typeof content.msgtype === "string" ? content.msgtype : "m.text",
    body: typeof content.body === "string" ? content.body : "",
    ts: ev.getTs(),
    status: mapStatus(ev.status),
    ask: parseAsk(content),
    drafts: parseDrafts(content),
    approval: parseApproval(content),
    via: fromUser && typeof content["com.agentstudio.via"] === "string" ? (content["com.agentstudio.via"] as string) : null,
    history: isHistory(content),
    file: fileOf(content),
  };
}

/** Messages of the live timeline (including local echoes), oldest first. */
export function roomMessages(room: RoomLike, myUserId: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const ev of room.getLiveTimeline().getEvents()) {
    const m = toChatMessage(ev, room, myUserId);
    if (m) out.push(m);
  }
  return out;
}

/**
 * Unread count, computed locally: messages from others after the user's read
 * receipt (or after the user's own last message), within the loaded timeline.
 */
export function unreadCount(room: RoomLike, myUserId: string): number {
  const events = room.getLiveTimeline().getEvents();
  const readUpTo = room.getEventReadUpTo(myUserId);
  let n = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (readUpTo && ev.getId() === readUpTo) break;
    if (ev.getSender() === myUserId) break;
    if (ev.getType() === "m.room.message" && !ev.isRedacted()) n++;
  }
  return n;
}

type SdkLogger = NonNullable<ICreateClientOpts["logger"]>;

/** matrix-js-sdk logger that only prints warnings and errors. */
export const quietLogger: SdkLogger = (() => {
  const c = (globalThis as unknown as { console?: { warn(...a: unknown[]): void; error(...a: unknown[]): void } })
    .console;
  const noop = () => {};
  const l: SdkLogger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: (...a: unknown[]) => c?.warn("[matrix]", ...a),
    error: (...a: unknown[]) => c?.error("[matrix]", ...a),
    getChild: () => l,
  };
  return l;
})();

/** Sender of the user's pending invite (works for DMs and groups alike). */
export function inviterOf(room: Room, userId: string): string | undefined {
  const ev =
    room.getMember(userId)?.events.member ??
    room.currentState.getStateEvents("m.room.member", userId) ??
    undefined;
  return ev?.getContent().membership === "invite" ? ev.getSender() : undefined;
}

// ---- client wrapper ----------------------------------------------------------

export type AgentStudioEventKind = "ask" | "drafts" | "approval";
export type AgentStudioEventListener = (
  kind: AgentStudioEventKind,
  roomId: string,
  payload: AskPayload | DraftsPayload | ApprovalPayload,
) => void;

export type SyncStatus = "stopped" | "starting" | "syncing" | "error";

/** Anything with startup(), such as matrix-js-sdk's IndexedDBStore. */
export type MatrixStore = NonNullable<ICreateClientOpts["store"]>;

export interface AgentStudioMatrixOptions {
  credentials: MatrixCredentials;
  /**
   * Optional persistent store, e.g.
   *   (userId) => new IndexedDBStore({ indexedDB, dbName: `agentstudio-${userId}`, localStorage })
   * startup() is called for you. Default: in-memory.
   */
  storeFactory?: (userId: string) => MatrixStore;
  initialSyncLimit?: number; // default 20
  /** Accept invites from our bridge bots/ghosts automatically (default true). */
  autoJoin?: boolean;
  /** Passed through to createClient (fetchFn, logger, ...). */
  clientOpts?: Partial<ICreateClientOpts>;
}

export type SendResult = { ok: true; eventId: string } | { ok: false; error: unknown };

export class AgentStudioMatrix implements VersionedSource {
  readonly client: MatrixClient;
  readonly userId: string;
  readonly serverName: string;
  private readonly changes = new ChangeEmitter();
  private readonly agentStudioListeners = new Set<AgentStudioEventListener>();
  private readonly liveListeners = new Set<LiveMessageListener>();
  private readonly joining = new Set<string>();
  private readonly autoJoin: boolean;
  private readonly initialSyncLimit: number;
  private readonly store: MatrixStore | undefined;
  private syncStatus: SyncStatus = "stopped";
  /** Set once the first sync is done; stays set through errors and reconnects. */
  private synced = false;
  private firstSync: Promise<void> | null = null;

  constructor(opts: AgentStudioMatrixOptions) {
    const c = opts.credentials;
    this.userId = c.user_id;
    this.serverName = parseMxid(c.user_id)?.server ?? "";
    this.autoJoin = opts.autoJoin ?? true;
    this.initialSyncLimit = opts.initialSyncLimit ?? 20;
    this.store = opts.storeFactory?.(c.user_id);
    this.client = createClient({
      logger: quietLogger,
      ...opts.clientOpts,
      baseUrl: c.homeserver_url,
      accessToken: c.access_token,
      userId: c.user_id,
      deviceId: c.device_id,
      timelineSupport: true,
      ...(this.store ? { store: this.store } : {}),
    });
    this.wire();
  }

  // VersionedSource: any change to rooms, timelines, receipts or sync state.
  subscribe = (l: Listener): Unsubscribe => this.changes.subscribe(l);
  version = (): number => this.changes.version();

  getSyncStatus(): SyncStatus {
    return this.syncStatus;
  }

  /** Listen for incoming AgentStudio custom messages (ask / drafts / approval). */
  onAgentStudioEvent(l: AgentStudioEventListener): Unsubscribe {
    this.agentStudioListeners.add(l);
    return () => {
      this.agentStudioListeners.delete(l);
    };
  }

  /**
   * Listen for messages from others that arrive live after the first sync
   * (not the initial sync, not scrollback). `ageMs` tells history that arrives
   * later (bridge backfill, imports) from new messages.
   */
  onLiveMessage(l: LiveMessageListener): Unsubscribe {
    this.liveListeners.add(l);
    return () => {
      this.liveListeners.delete(l);
    };
  }

  /** Starts syncing. Resolves after the first successful sync. */
  start(): Promise<void> {
    if (this.firstSync) return this.firstSync;
    this.syncStatus = "starting";
    this.changes.emit();
    this.firstSync = (async () => {
      const prepared = new Promise<void>((resolve) => {
        const onSync = (state: SyncState) => {
          if (state === SyncState.Prepared || state === SyncState.Syncing) {
            this.client.off(ClientEvent.Sync, onSync);
            resolve();
          }
        };
        this.client.on(ClientEvent.Sync, onSync);
      });
      if (this.store) await this.store.startup();
      await this.client.startClient({
        initialSyncLimit: this.initialSyncLimit,
        lazyLoadMembers: true,
      });
      await prepared;
      this.joinPendingInvites();
    })();
    return this.firstSync;
  }

  stop(): void {
    this.client.stopClient();
    this.client.removeAllListeners();
    this.syncStatus = "stopped";
    this.synced = false;
    this.firstSync = null;
    this.changes.emit();
  }

  /**
   * The avatar to show for a chat: the other participant's in a one-on-one chat
   * (people and agents; bridge bots don't count), else the room's own.
   */
  avatarMxc(roomId: string): string | null {
    const room = this.client.getRoom(roomId);
    if (!room) return null;
    const others = room.getJoinedMembers().filter((m) => m.userId !== this.userId && !/^@[^:]*bot:/.test(m.userId));
    if (others.length === 1) return others[0]!.getMxcAvatarUrl() ?? room.getMxcAvatarUrl() ?? null;
    return room.getMxcAvatarUrl() ?? null;
  }

  /**
   * How to download an mxc:// thumbnail: authenticated media (MSC3916), so
   * callers fetch it with these headers (an <img src> alone can't).
   */
  mediaRequest(mxc: string, size: number): { url: string; headers: Record<string, string> } | null {
    const url = this.client.mxcUrlToHttp(mxc, size, size, "crop", false, true, true);
    const token = this.client.getAccessToken();
    return url && token ? { url, headers: { Authorization: `Bearer ${token}` } } : null;
  }

  /** URL and auth header to download an mxc:// file in full (authenticated media). */
  mediaDownloadRequest(mxc: string): { url: string; headers: Record<string, string> } | null {
    const url = this.client.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true, true);
    const token = this.client.getAccessToken();
    return url && token ? { url, headers: { Authorization: `Bearer ${token}` } } : null;
  }

  getRoom(roomId: string): Room | null {
    return this.client.getRoom(roomId);
  }

  getRooms(): Room[] {
    return this.client.getRooms();
  }

  getMessages(roomId: string): ChatMessage[] {
    const room = this.client.getRoom(roomId);
    return room ? roomMessages(room, this.userId) : [];
  }

  /** Observable messages of one room (stable snapshot between changes). */
  messagesStore(roomId: string): ReadableStore<ChatMessage[]> {
    return derived(this, () => this.getMessages(roomId));
  }

  /** Send plain text. The message appears at once with status "sending". */
  sendText(roomId: string, text: string): Promise<SendResult> {
    return this.sendContent(roomId, { msgtype: "m.text", body: text });
  }

  /** Send arbitrary m.room.message content (e.g. a com.agentstudio.ask message). */
  async sendContent(roomId: string, content: Record<string, unknown>): Promise<SendResult> {
    try {
      // Custom keys are allowed in m.room.message content; the SDK's type is narrower.
      const r = await this.client.sendMessage(roomId, content as never);
      return { ok: true, eventId: r.event_id };
    } catch (error) {
      this.changes.emit();
      return { ok: false, error };
    }
  }

  /** Resend a failed message (status "failed") by its ChatMessage id. */
  async retry(roomId: string, messageId: string): Promise<SendResult> {
    const room = this.client.getRoom(roomId);
    const ev = room
      ?.getLiveTimeline()
      .getEvents()
      .find((e) => e.getId() === messageId);
    if (!room || !ev || ev.status !== EventStatus.NOT_SENT) {
      return { ok: false, error: new Error("No failed message with that id") };
    }
    try {
      const r = await this.client.resendEvent(ev, room);
      return { ok: true, eventId: r.event_id };
    } catch (error) {
      this.changes.emit();
      return { ok: false, error };
    }
  }

  unreadCount(roomId: string): number {
    const room = this.client.getRoom(roomId);
    return room ? unreadCount(room, this.userId) : 0;
  }

  /** Send a read receipt for the latest remote event, if it is not read yet. */
  async markRead(roomId: string): Promise<void> {
    const room = this.client.getRoom(roomId);
    if (!room) return;
    const events = room.getLiveTimeline().getEvents();
    let last: MatrixEvent | undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!;
      if (ev.status === null && ev.getId()?.startsWith("$")) {
        last = ev;
        break;
      }
    }
    if (!last || room.getEventReadUpTo(this.userId) === last.getId()) return;
    try {
      await this.client.sendReadReceipt(last, ReceiptType.Read, true);
    } catch {
      // Receipts are best effort.
    }
    this.changes.emit();
  }

  /** Leave a chat and forget it, so it disappears from every client. */
  async leaveRoom(roomId: string): Promise<void> {
    await this.client.leave(roomId);
    await this.client.forget(roomId).catch(() => {});
    this.changes.emit();
  }

  /** Load older messages into the live timeline. Returns false at the start. */
  async loadOlder(roomId: string, limit = 20): Promise<boolean> {
    const room = this.client.getRoom(roomId);
    if (!room) return false;
    await this.client.scrollback(room, limit);
    return room.oldState.paginationToken !== null;
  }

  // ---- internals ---------------------------------------------------------------

  private wire() {
    const c = this.client;
    const changed = () => this.changes.emit();
    c.on(ClientEvent.Sync, (state) => {
      if (state === SyncState.Prepared || state === SyncState.Syncing || state === SyncState.Catchup) this.synced = true;
      this.syncStatus =
        state === SyncState.Error
          ? "error"
          : state === SyncState.Stopped
            ? "stopped"
            : state === SyncState.Prepared || state === SyncState.Syncing || state === SyncState.Catchup
              ? "syncing"
              : this.syncStatus;
      changed();
    });
    c.on(ClientEvent.Room, (room) => {
      this.maybeAutoJoin(room);
      changed();
    });
    c.on(ClientEvent.DeleteRoom, changed);
    c.on(RoomEvent.MyMembership, (room) => {
      this.maybeAutoJoin(room);
      changed();
    });
    c.on(RoomEvent.Timeline, (ev, room, toStartOfTimeline, _removed, data) => {
      changed();
      if (!room || toStartOfTimeline || !data?.liveEvent) return;
      if (ev.getSender() === this.userId) return;
      this.dispatchAgentStudio(ev, room.roomId);
      this.dispatchLive(ev, room);
    });
    c.on(RoomEvent.TimelineReset, changed);
    c.on(RoomEvent.Name, changed);
    c.on(RoomEvent.Receipt, changed);
    c.on(RoomEvent.LocalEchoUpdated, changed);
    c.on(RoomEvent.Redaction, changed);
    c.on(RoomStateEvent.Events, changed);
    c.on(RoomMemberEvent.Name, changed);
    c.on(RoomMemberEvent.Membership, changed);
  }

  private dispatchAgentStudio(ev: MatrixEvent, roomId: string) {
    if (ev.getType() !== "m.room.message" || this.agentStudioListeners.size === 0) return;
    const content = ev.getContent();
    const found: [AgentStudioEventKind, AskPayload | DraftsPayload | ApprovalPayload | null][] = [];
    if (ASK_KEY in content) found.push(["ask", parseAsk(content)]);
    if (DRAFTS_KEY in content) found.push(["drafts", parseDrafts(content)]);
    if (APPROVAL_KEY in content) found.push(["approval", parseApproval(content)]);
    for (const [kind, payload] of found) {
      if (!payload) continue;
      for (const l of [...this.agentStudioListeners]) {
        try {
          l(kind, roomId, payload);
        } catch {
          // ignore listener errors
        }
      }
    }
  }

  private dispatchLive(ev: MatrixEvent, room: Room) {
    // Not during the first sync; afterwards also while recovering from a sync
    // error (the recovery batch arrives before "syncing" is reported again).
    if (this.liveListeners.size === 0 || !this.synced) return;
    // Edits are not new messages.
    if (ev.isRelation("m.replace")) return;
    const message = toChatMessage(ev, room, this.userId);
    if (!message) return;
    // Bridges backfill history with the original timestamps, but the server's
    // unsigned age counts from when it received the event; take the larger.
    const ageMs = Math.max(ev.getLocalAge(), Date.now() - ev.getTs());
    for (const l of [...this.liveListeners]) {
      try {
        l({ message, room, ageMs });
      } catch {
        // ignore listener errors
      }
    }
  }

  private joinPendingInvites() {
    for (const room of this.client.getRooms()) this.maybeAutoJoin(room);
  }

  private maybeAutoJoin(room: Room) {
    if (!this.autoJoin || room.getMyMembership() !== "invite") return;
    if (this.joining.has(room.roomId)) return;
    if (!shouldAutoJoin(inviterOf(room, this.userId), this.serverName)) return;
    this.joining.add(room.roomId);
    this.client
      .joinRoom(room.roomId)
      .catch(() => undefined)
      .finally(() => this.joining.delete(room.roomId));
  }
}
