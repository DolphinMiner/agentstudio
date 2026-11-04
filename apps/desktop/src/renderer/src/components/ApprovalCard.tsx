import { useEffect, useState } from "react";
import { approvalStateText, formatExpiry, isApiError, isExpired } from "@agentstudio/core";
import { errorText } from "../lib/errors";
import { useNow, useStore } from "../lib/hooks";
import { useWorkspace } from "../lib/workspace";
import { Icon } from "./Icon";

/**
 * An approval card. Its state always comes from the REST API (via the
 * ApprovalsStore cache), never from the Matrix event.
 */
export function ApprovalCard({ approvalId }: { approvalId: string }) {
  const { rt } = useWorkspace();
  const cards = useStore(rt.approvals.cards);
  const a = cards[approvalId];
  const now = useNow(15_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!a) rt.approvals.load(approvalId).catch(() => setLoadError(true));
  }, [rt, approvalId, a]);

  if (!a) {
    return (
      <div data-testid="approval-card" className="card approval-card loading">
        <div className="muted">{loadError ? "Could not load this approval." : "Loading approval…"}</div>
      </div>
    );
  }

  const stateText = approvalStateText(a, now);
  const open = a.state === "pending" && !isExpired(a, now);
  const expiry = open ? formatExpiry(a.expires_at, now) : null;

  async function decide(key: string) {
    setBusy(key);
    setError(null);
    try {
      await rt.approvals.decide(approvalId, key);
    } catch (e) {
      // On a conflict or expiry the card already shows the server's state.
      if (!isApiError(e, "version_conflict") && !isApiError(e, "expired")) setError(errorText(e));
    } finally {
      rt.agents.trigger();
      setBusy(null);
    }
  }

  return (
    <div data-testid="approval-card" data-approval-id={a.id} className={`card approval-card state-${a.state}${open ? " open" : ""}`}>
      <div className="approval-head">
        <span className="approval-from">{open ? `${a.agent_name} is asking` : a.agent_name}</span>
        {expiry && (
          <span data-testid="approval-expiry" className="expiry">
            <Icon name="clock" size={13} stroke={2} />
            {expiry}
          </span>
        )}
      </div>
      <div data-testid="approval-title" className="approval-title display">
        {a.title}
      </div>
      {a.summary && <p className="approval-summary">{a.summary}</p>}
      {a.details.length > 0 && (
        <dl className="details">
          {a.details.map((d, i) => (
            <div key={i} data-testid="approval-detail" className="detail">
              <dt>{d.label}</dt>
              <dd>{d.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {open ? (
        <div className="choices">
          {a.choices.map((c) => (
            <button
              key={c.key}
              data-testid={`approval-choice-${c.key}`}
              className={`pill-btn ${c.category === "approve" ? "approve" : "deny"}`}
              disabled={busy !== null}
              onClick={() => void decide(c.key)}
            >
              {busy === c.key ? "…" : c.label}
            </button>
          ))}
        </div>
      ) : (
        stateText && (
          <div data-testid="approval-state" className={`approval-state ${a.decision ? `decided ${a.choices.find((c) => c.key === a.decision?.choice)?.category ?? ""}` : "closed"}`}>
            {stateText}
          </div>
        )
      )}
      {a.state === "decided" && a.delivery_state === "failed" && (
        <div className="muted small">The agent couldn't be reached. It gets your answer when it's back.</div>
      )}
      {error && (
        <div className="error small" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
