import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AGENT_NOTIFY_MODES, agentNotifyMode, classifyRoom, roomDisplayName, type ChatMessage } from "@agentstudio/core";
import { useStore, useVersion } from "../lib/hooks";
import { AGENT_MODE_LABELS, notificationPrefs, setAgentNotifyMode } from "../lib/notifications";
import { useMxcImage } from "../lib/media";
import { useWorkspace } from "../lib/workspace";
import { ApprovalCard } from "./ApprovalCard";
import { agentBadge, agentMark, useLocalConnectors } from "../lib/marks";
import { RoomAvatar } from "./Avatar";
import { markForNetwork } from "./Mark";
import { DraftsCard } from "./DraftsCard";
import { Icon } from "./Icon";

export function ChatView({ roomId }: { roomId: string }) {
  const { rt, ask, go, closeRoom } = useWorkspace();
  const me = rt.matrix.userId;
  const messages = useStore(useMemo(() => rt.matrix.messagesStore(roomId), [rt, roomId]));
  useVersion(rt.matrix);
  const agents = useStore(rt.agents);
  const room = rt.matrix.getRoom(roomId);
  const cls = room ? classifyRoom(room, me) : null;
  const agent = agents.items.find((a) => a.room_id === roomId);
  const name = agent?.name ?? (room ? roomDisplayName(room, me) : "");
  // Bridge rooms also hold bridge bots and ghosts; a chat is a group when more
  // than one other person actually speaks in it.
  const isGroup = !cls?.isAgentRoom && new Set(messages.filter((m) => !m.own).map((m) => m.sender)).size > 1;
  const local = useLocalConnectors();
  const mark = agent ? agentMark(agent, local) : null;
  const prefs = useStore(notificationPrefs);

  // ---- composer (text survives room switches; "Use" can prefill it) ----
  const initial = rt.composer.get(roomId);
  const [text, setText] = useState(initial?.text ?? "");
  const fromDraft = useRef(initial?.fromDraft ?? null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (text || fromDraft.current) rt.composer.set(roomId, { text, fromDraft: fromDraft.current });
    else rt.composer.delete(roomId);
  }, [rt, roomId, text]);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  async function send() {
    const body = text.trim();
    if (!body) return;
    const draft = fromDraft.current;
    fromDraft.current = null;
    setText("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    const res = await rt.matrix.sendText(roomId, body);
    // The user sent (possibly edited) agent draft text back to the origin chat.
    if (res.ok && draft) rt.tasks.markSent(draft.taskId, draft.draftIndex).catch(() => undefined);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  // ---- read receipts while the chat is visible and focused ----
  const lastId = messages.at(-1)?.id;
  useEffect(() => {
    const mark = () => {
      if (document.hasFocus()) void rt.matrix.markRead(roomId);
    };
    mark();
    window.addEventListener("focus", mark);
    return () => window.removeEventListener("focus", mark);
  }, [rt, roomId, lastId]);

  // ---- keep the timeline scrolled to the bottom when new messages arrive ----
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(true);
  async function loadOlder() {
    setLoadingOlder(true);
    try {
      setHasOlder(await rt.matrix.loadOlder(roomId));
    } finally {
      setLoadingOlder(false);
    }
  }

  // ---- delete the chat (leave and forget the room) ----
  const [menu, setMenu] = useState<"closed" | "open" | "confirm">("closed");
  const [deleting, setDeleting] = useState(false);
  async function deleteChat() {
    setDeleting(true);
    try {
      await rt.matrix.leaveRoom(roomId);
      closeRoom();
    } finally {
      setDeleting(false);
      setMenu("closed");
    }
  }

  if (!room) return <div className="placeholder muted">This chat is not available.</div>;

  return (
    <div className="chat">
      <header className="chat-header">
        <button className="icon-btn back-btn" onClick={closeRoom} title="Back to chats" aria-label="Back to chats">
          <Icon name="back" />
        </button>
        <div className="chat-identity" data-testid="chat-identity">
          <RoomAvatar
            roomId={roomId}
            serviceBadge={agent ? agentBadge(agent, local) : null}
            name={name}
            agent={cls?.isAgentRoom}
            mark={mark}
            badge={cls?.isAgentRoom ? null : markForNetwork(cls?.network ?? "")}
            attention={!!agent && agent.pending_approvals > 0}
            size={56}
          />
          <h2 data-testid="chat-title" className="name-pill display">
            {name}
          </h2>
          <div className="chat-sub">
            <span data-testid="chat-network">{cls?.networkLabel}</span>
            {agent && (agent.status_text || agent.status === "working") && (
              <span className={`status-dot status-${agent.status}`}>{agent.status_text || "Working"}</span>
            )}
          </div>
        </div>
        <div className="chat-header-side">
          {agent && agent.pending_approvals > 0 && (
            <button className="porch-pill" onClick={() => go("approvals")}>
              {agent.pending_approvals} waiting on you
            </button>
          )}
          <div className="menu-anchor">
            <button
              className="icon-btn"
              data-testid="chat-menu"
              aria-label="Chat options"
              aria-expanded={menu !== "closed"}
              onClick={() => setMenu((m) => (m === "closed" ? "open" : "closed"))}
            >
              <Icon name="more" />
            </button>
            {menu !== "closed" && (
              <div className="menu" role="menu" onMouseLeave={() => menu === "open" && setMenu("closed")}>
                {menu === "open" ? (
                  <>
                    {agent && (
                      <div className="menu-section" role="group" aria-label="Notifications">
                        <div className="menu-label">Notifications</div>
                        {AGENT_NOTIFY_MODES.map((mode) => {
                          const checked = agentNotifyMode(prefs, agent.id) === mode;
                          return (
                            <button
                              key={mode}
                              role="menuitemradio"
                              aria-checked={checked}
                              className="menu-item check"
                              data-testid={`chat-notify-${mode}`}
                              onClick={() => {
                                setMenu("closed");
                                void setAgentNotifyMode(agent.id, mode);
                              }}
                            >
                              <span className="menu-check">{checked && <Icon name="check" size={15} />}</span>
                              {AGENT_MODE_LABELS[mode]}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <button role="menuitem" className="menu-item danger" data-testid="chat-delete" onClick={() => setMenu("confirm")}>
                      Delete chat
                    </button>
                  </>
                ) : (
                  <div className="menu-confirm">
                    <p>Delete this chat from AgentStudio? Its messages go too.</p>
                    <div className="menu-actions">
                      <button className="pill-btn quiet small" onClick={() => setMenu("closed")}>
                        Keep
                      </button>
                      <button className="pill-btn danger small" data-testid="chat-delete-confirm" disabled={deleting} onClick={() => void deleteChat()}>
                        {deleting ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </header>
      <div
        data-testid="timeline"
        className="timeline"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {hasOlder && messages.length >= 20 && (
          <button className="btn quiet center-block" disabled={loadingOlder} onClick={() => void loadOlder()}>
            {loadingOlder ? "Loading…" : "Load earlier messages"}
          </button>
        )}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const gap = !prev || m.ts - prev.ts > 30 * 60_000;
          const next = messages[i + 1];
          const lastInRun = !next || next.sender !== m.sender || next.ts - m.ts > 30 * 60_000;
          return (
            <div key={m.id} className="timeline-item">
              {gap && <div className="day-sep">{dayLabel(m.ts)}</div>}
              <MessageItem
                m={m}
                tail={lastInRun}
                showName={isGroup && !m.own && (gap || prev?.sender !== m.sender)}
                canAsk={!cls?.isAgentRoom && !m.approval && !m.drafts && !!m.body.trim()}
                onAsk={() => ask(roomId, m.id)}
                onRetry={() => void rt.matrix.retry(roomId, m.id)}
              />
            </div>
          );
        })}
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={inputRef}
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
          }}
          data-testid="composer-input"
          rows={1}
          placeholder={`Message ${name}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button data-testid="composer-send" className="send-btn" disabled={!text.trim()} title="Send" aria-label="Send">
          <Icon name="send" size={18} stroke={2.2} />
        </button>
      </form>
    </div>
  );
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `Today ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

function MessageItem({
  m,
  tail,
  showName,
  canAsk,
  onAsk,
  onRetry,
}: {
  m: ChatMessage;
  tail: boolean;
  showName: boolean;
  canAsk: boolean;
  onAsk(): void;
  onRetry(): void;
}) {
  const time = new Date(m.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const isCard = !!(m.approval || m.drafts);
  return (
    <div
      data-testid="message"
      data-sender={m.senderName}
      data-own={String(m.own)}
      className={`message${m.own ? " own" : ""}${m.msgtype === "m.notice" ? " notice" : ""}${isCard ? " card-message" : ""}${tail ? " tail" : ""}`}
    >
      {showName && <div className="sender">{m.senderName}</div>}
      <div className="message-row">
        {m.approval ? (
          <ApprovalCard approvalId={m.approval.approval_id} />
        ) : m.drafts ? (
          <DraftsCard payload={m.drafts} />
        ) : (
          <div className={`bubble${m.ask ? " ask" : ""}${m.file ? " file-bubble" : ""}`} title={time}>
            {m.file ? (
              <MessageFile file={m.file} />
            ) : (
              <div data-testid="message-body" className="message-body">
                {m.body}
              </div>
            )}
          </div>
        )}
        {canAsk && (
          <div className="msg-actions">
            <button data-testid="message-ask" className="hover-action" onClick={onAsk} title="Ask an agent">
              <Icon name="spark" size={14} /> Ask an agent
            </button>
          </div>
        )}
      </div>
      {m.via && (
        <div data-testid="message-via" className="meta">
          In {m.via}
        </div>
      )}
      {m.status === "sending" && <div className="meta">Sending…</div>}
      {m.status === "failed" && (
        <div data-testid="message-failed" className="meta failed">
          Not sent.{" "}
          <button className="btn quiet small" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

/** An image or file a bridge posted: images inline, other files as a chip that downloads. */
function MessageFile({ file }: { file: NonNullable<ChatMessage["file"]> }) {
  const { rt } = useWorkspace();
  const isImage = file.mime.startsWith("image/");
  const thumb = useMxcImage(rt, isImage ? file.mxc : null, 320);
  async function download() {
    const req = rt.matrix.mediaDownloadRequest(file.mxc);
    if (!req) return;
    const res = await fetch(req.url, { headers: req.headers });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  if (isImage && thumb) {
    return <img data-testid="message-image" className="message-image" src={thumb} alt={file.name} onClick={() => void download()} />;
  }
  return (
    <button data-testid="message-file" className="message-file" onClick={() => void download()}>
      <Icon name="file" size={16} />
      <span>{file.name}</span>
    </button>
  );
}
