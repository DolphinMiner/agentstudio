import { useEffect, useState } from "react";
import { ApprovalCard } from "../components/ApprovalCard";
import { useStore } from "../lib/hooks";
import { useWorkspace } from "../lib/workspace";

export function ApprovalsScreen() {
  const { rt } = useWorkspace();
  const snap = useStore(rt.approvals);
  // Keep cards decided on this screen visible (showing their new state) until
  // the user leaves; new pending approvals go on top.
  const [shown, setShown] = useState<string[]>([]);
  useEffect(() => {
    setShown((prev) => {
      const fresh = snap.items.map((a) => a.id).filter((id) => !prev.includes(id));
      return fresh.length ? [...fresh, ...prev] : prev;
    });
  }, [snap.items]);
  useEffect(() => {
    void rt.approvals.refresh();
  }, [rt]);

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="display">Approvals</h1>
        <p className="muted">When an agent needs a yes before it acts, it waits here.</p>
      </header>
      <div className="page-scroll">
        {shown.length === 0 ? (
          snap.loading ? (
            <p className="muted pad">Loading…</p>
          ) : (
            <div data-testid="approvals-empty" className="empty">
              <h3 className="display">The porch light is off</h3>
              <p className="muted">Nothing is waiting on you. When an agent asks before booking, buying or sending, it shows up here.</p>
            </div>
          )
        ) : (
          <div data-testid="approvals-list" className="card-list">
            {shown.map((id) => (
              <ApprovalCard key={id} approvalId={id} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
