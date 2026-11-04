import { useState } from "react";
import { agentHealth, type ChatRow, type InboxFilter } from "@agentstudio/core";
import { RoomAvatar } from "../components/Avatar";
import { ChatView } from "../components/ChatView";
import { Icon } from "../components/Icon";
import { markForNetwork } from "../components/Mark";
import { useNow, useStore, useVersion } from "../lib/hooks";
import { formatTime } from "../lib/logic";
import { agentBadge, agentMark, useLocalConnectors } from "../lib/marks";
import { useWorkspace } from "../lib/workspace";

// No "People" filter on the Mac for now: AgentStudio is about your agents, and
// people only show up through a chat network (the demo one, for now). They're under All.
const FILTERS: { id: InboxFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "agents", label: "Agents" },
];

export function InboxScreen({ composerNonce }: { composerNonce: number }) {
  const { rt, route, openRoom, go } = useWorkspace();
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [query, setQuery] = useState("");
  const rows = useStore(rt.inbox.rows);
  const agents = useStore(rt.agents);
  const local = useLocalConnectors();
  useVersion(rt.matrix);
  const q = query.trim().toLowerCase();
  const visible = rt.inbox.filtered(filter).filter((r) => !q || r.name.toLowerCase().includes(q) || (r.lastMessage ?? "").toLowerCase().includes(q));
  const synced = rt.matrix.getSyncStatus() === "syncing";
  const now = useNow(60_000);
  const selected = route.roomId && rt.matrix.getRoom(route.roomId) ? route.roomId : null;
  const agentOf = (row: ChatRow) => (row.isAgent ? agents.items.find((a) => a.id === row.agentId) : undefined);
  const markOf = (row: ChatRow) => (row.isAgent ? agentMark(agentOf(row), local) : null);
  const badgeOf = (row: ChatRow) => (row.isAgent ? agentBadge(agentOf(row), local) : null);
  // "Waiting on you": agents with a decision pending first, then the ones at work. The
  // full list is below; this only lights up what needs you, and is gone when nothing does.
  const waiting = rows
    .filter((r) => r.isAgent && (r.needsYou || r.agentStatus === "working"))
    .sort((a, b) => Number(b.needsYou) - Number(a.needsYou));
  const WAITING_MAX = 6;
  // Agents with a problem (signed out on their service, or not reachable).
  const healthOf = (row: ChatRow) => {
    const a = agentOf(row);
    return a ? agentHealth(a, local) : null;
  };
  const troubled = rows.filter((r) => r.isAgent && (healthOf(r)?.health ?? "ok") !== "ok");
  const [troubleDismissed, setTroubleDismissed] = useState(0);

  return (
    <div className={`inbox${selected ? " has-room" : ""}`}>
      <section className="list-pane glass">
        <header className="list-header">
          <h1 className="display">Inbox</h1>
          <label className="search">
            <Icon name="search" size={16} />
            <input placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search chats" />
          </label>
          <div className="chips" role="tablist">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                role="tab"
                aria-selected={filter === f.id}
                data-testid={`inbox-filter-${f.id}`}
                className={`chip${filter === f.id ? " active" : ""}`}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </header>
        <div className="list-scroll">
          {troubled.length > 0 && troubled.length !== troubleDismissed && !q && (
            <div className="trouble-bar" role="status" data-testid="agent-trouble">
              <span>
                {troubled.length === 1 ? `${troubled[0]!.name} needs attention` : `${troubled.length} agents need attention`}
              </span>
              <button className="btn quiet small" data-testid="agent-trouble-fix" onClick={() => go("connect")}>
                Fix
              </button>
              <button className="icon-btn small" aria-label="Dismiss" onClick={() => setTroubleDismissed(troubled.length)}>
                <Icon name="close" size={14} />
              </button>
            </div>
          )}
          {waiting.length > 0 && filter === "all" && !q && (
            <div className="agent-strip" aria-label="Waiting on you" data-testid="agent-waiting">
              <div className="strip-label">{waiting.some((r) => r.needsYou) ? "Waiting on you" : "At work"}</div>
              <div className="strip-items">
                {waiting.slice(0, WAITING_MAX).map((r) => (
                  <button
                    key={r.roomId}
                    data-testid="agent-waiting-item"
                    className={`strip-item${r.roomId === selected ? " active" : ""}`}
                    onClick={() => openRoom(r.roomId)}
                  >
                    <RoomAvatar roomId={r.roomId} name={r.name} agent mark={markOf(r)} serviceBadge={badgeOf(r)} size={44} attention={r.needsYou} />
                    <span className="strip-name">{r.name}</span>
                  </button>
                ))}
                {waiting.length > WAITING_MAX && (
                  <button className="strip-item strip-more" data-testid="agent-waiting-more" onClick={() => go("approvals")}>
                    <span className="strip-more-count">+{waiting.length - WAITING_MAX}</span>
                    <span className="strip-name">More</span>
                  </button>
                )}
              </div>
            </div>
          )}
          {!synced && rows.length === 0 ? (
            <p className="muted center pad">Loading chats…</p>
          ) : rows.length === 0 ? (
            <div data-testid="inbox-empty" className="empty">
              <h3 className="display">Nobody's on the porch yet</h3>
              <p className="muted">Connect a chat account or an agent, and its conversations show up here.</p>
              <button data-testid="inbox-connect" className="btn primary" onClick={() => go("connect")}>
                Connect an account
              </button>
            </div>
          ) : (
            <ul data-testid="chat-list" className="chat-list">
              {visible.map((row) => (
                <ChatRowItem
                  key={row.roomId}
                  row={row}
                  now={now}
                  mark={markOf(row)}
                  serviceBadge={badgeOf(row)}
                  health={healthOf(row)}
                  active={row.roomId === selected}
                  onOpen={() => openRoom(row.roomId)}
                />
              ))}
              {visible.length === 0 && <li className="muted center pad">{q ? "No chats match." : "Nothing here."}</li>}
            </ul>
          )}
        </div>
      </section>
      <section className="chat-pane">
        {selected ? (
          <ChatView key={`${selected}:${composerNonce}`} roomId={selected} />
        ) : (
          <div className="placeholder">
            <p className="muted">Pick a conversation.</p>
          </div>
        )}
      </section>
    </div>
  );
}

function ChatRowItem({
  row,
  now,
  mark,
  serviceBadge,
  health,
  active,
  onOpen,
}: {
  row: ChatRow;
  now: number;
  mark: ReturnType<typeof markForNetwork>;
  serviceBadge: ReturnType<typeof markForNetwork>;
  health: ReturnType<typeof agentHealth>;
  active: boolean;
  onOpen(): void;
}) {
  const preview = row.lastMessage ? (row.lastSender && row.lastOwn ? `You: ${row.lastMessage}` : row.lastMessage) : "";
  const problem = health && health.health !== "ok" ? (health.health === "needs_login" ? "Sign in again" : "Not connected") : null;
  const status = row.isAgent ? problem || row.agentStatusText || (row.agentStatus === "working" ? "Working" : null) : null;
  return (
    <li>
      <button
        data-testid="chat-row"
        data-room-name={row.name}
        className={`chat-row${active ? " active" : ""}${row.unread > 0 ? " unread" : ""}`}
        onClick={onOpen}
      >
        <RoomAvatar
          roomId={row.roomId}
          serviceBadge={serviceBadge}
          name={row.name}
          agent={row.isAgent}
          mark={mark}
          badge={row.isAgent ? null : markForNetwork(row.network)}
          attention={row.needsYou}
          size={44}
        />
        <div className="row-main">
          <div className="row-top">
            <span className="row-name">{row.name}</span>
            <span data-testid="chat-row-network" className="row-network">
              {row.networkLabel}
            </span>
            <span className="row-time">{row.lastTs ? formatTime(row.lastTs, now) : ""}</span>
          </div>
          <div className="row-bottom">
            {status && (
              <span data-testid="chat-row-status" className={`row-status status-${problem ? "problem" : (row.agentStatus ?? "idle")}`} title={health?.message}>
                {status}
              </span>
            )}
            <span className="row-preview">{preview}</span>
            {row.needsYou && (
              <span data-testid="chat-row-needs-you" className="needs-you">
                Needs you
              </span>
            )}
            {row.unread > 0 && (
              <span data-testid="chat-row-unread" className="count-badge">
                {row.unread}
              </span>
            )}
          </div>
        </div>
      </button>
    </li>
  );
}
