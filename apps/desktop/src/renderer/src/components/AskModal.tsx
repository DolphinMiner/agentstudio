import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_ASK_REQUEST,
  askAgent,
  buildAskQuote,
  classifyRoom,
  roomDisplayName,
  roomMessages,
} from "@agentstudio/core";
import { errorText } from "../lib/errors";
import { useStore } from "../lib/hooks";
import { askableAgents } from "../lib/logic";
import { useWorkspace } from "../lib/workspace";
import { agentMark, useLocalConnectors } from "../lib/marks";
import { RoomAvatar } from "./Avatar";

/** "Ask an agent" sheet: pick an agent, edit the request, review the quoted context. */
export function AskModal({
  roomId,
  messageId,
  onClose,
  onSent,
}: {
  roomId: string;
  messageId: string;
  onClose(): void;
  onSent(agentRoomId: string): void;
}) {
  const { rt, go } = useWorkspace();
  const agentsSnap = useStore(rt.agents);
  const local = useLocalConnectors();
  const agents = askableAgents(agentsSnap.items);
  const [agentId, setAgentId] = useState<string | null>(null);
  const agent = agents.find((a) => a.id === agentId) ?? agents[0] ?? null;
  const [request, setRequest] = useState(DEFAULT_ASK_REQUEST);
  const [dontAsk, setDontAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Snapshot the context once, when the sheet opens.
  const ctx = useMemo(() => {
    const room = rt.matrix.getRoom(roomId);
    if (!room) return null;
    const me = rt.matrix.userId;
    const messages = roomMessages(room, me);
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return null;
    const cls = classifyRoom(room, me);
    return {
      anchor: messages[idx]!,
      lines: buildAskQuote(messages, idx),
      chatName: roomDisplayName(room, me),
      network: cls.network,
      app: cls.networkLabel,
    };
  }, [rt, roomId, messageId]);
  const [included, setIncluded] = useState<boolean[]>(() => ctx?.lines.map(() => true) ?? []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const skipPreview = agent?.consent.ask_without_preview ?? false;

  async function send() {
    if (!agent || !ctx) return;
    setBusy(true);
    setError(null);
    try {
      const lines = skipPreview ? ctx.lines : ctx.lines.filter((_, i) => included[i]);
      const { send: sent } = await askAgent(
        { tasks: rt.tasks, matrix: rt.matrix },
        {
          agent,
          request,
          origin: {
            room_id: roomId,
            network: ctx.network,
            chat_name: ctx.chatName,
            anchor_event_id: ctx.anchor.id,
          },
          app: ctx.app,
          lines,
          title: ctx.anchor.body,
        },
      );
      if (dontAsk && !skipPreview) await rt.agents.setConsent(agent.id, true).catch(() => undefined);
      if (!sent.ok) throw sent.error;
      onSent(agent.room_id!);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="ask-title">
        <h2 id="ask-title">Ask an agent</h2>
        {agents.length === 0 ? (
          <div className="empty small-empty">
            <p className="muted">
              {agentsSnap.loading ? "Loading agents…" : "No agents connected yet. Connect one to ask for help."}
            </p>
            {!agentsSnap.loading && (
              <button
                className="btn primary"
                onClick={() => {
                  onClose();
                  go("connect");
                }}
              >
                Connect an agent
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="agent-picker" role="radiogroup" aria-label="Agent">
              {agents.map((a) => (
                <button
                  key={a.id}
                  role="radio"
                  aria-checked={a.id === agent?.id}
                  data-testid={`ask-agent-${a.name}`}
                  className={`agent-choice${a.id === agent?.id ? " selected" : ""}`}
                  onClick={() => setAgentId(a.id)}
                >
                  <RoomAvatar roomId={a.room_id} name={a.name} agent mark={agentMark(a, local)} size={28} />
                  <span>{a.name}</span>
                </button>
              ))}
            </div>
            <label className="field">
              <span>What should it do?</span>
              <input data-testid="ask-request" value={request} onChange={(e) => setRequest(e.target.value)} />
            </label>
            {!ctx ? (
              <p className="error small">This message is no longer available.</p>
            ) : skipPreview ? (
              <p className="muted small">
                {ctx.lines.length} {ctx.lines.length === 1 ? "message" : "messages"} from {ctx.chatName} will be
                shared.
              </p>
            ) : (
              <>
                <div className="field-label">
                  Shared from {ctx.chatName} in {ctx.app}
                </div>
                <ul className="ask-lines">
                  {ctx.lines.map((l, i) => (
                    <li key={i} data-testid="ask-line" className={included[i] ? "" : "excluded"}>
                      <label>
                        <input
                          type="checkbox"
                          data-testid="ask-line-toggle"
                          checked={!!included[i]}
                          onChange={(e) => setIncluded((v) => v.map((x, j) => (j === i ? e.target.checked : x)))}
                        />
                        <span className="ask-speaker">{l.speaker}:</span> <span className="ask-text">{l.text}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                <label className="check">
                  <input
                    type="checkbox"
                    data-testid="ask-dont-ask"
                    checked={dontAsk}
                    onChange={(e) => setDontAsk(e.target.checked)}
                  />
                  Don't ask again for this agent
                </label>
              </>
            )}
          </>
        )}
        {error && (
          <p className="error small" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button data-testid="ask-cancel" className="btn secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            data-testid="ask-send"
            className="btn primary"
            disabled={busy || !agent || !ctx || (!skipPreview && !included.some(Boolean))}
            onClick={() => void send()}
          >
            {busy ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
