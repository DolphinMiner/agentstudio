import { useEffect } from "react";
import type { DraftsPayload } from "@agentstudio/core";
import { useStore } from "../lib/hooks";
import { useWorkspace } from "../lib/workspace";

/** Reply drafts from an agent. "Use" puts a draft into the origin chat's composer. */
export function DraftsCard({ payload }: { payload: DraftsPayload }) {
  const { rt, placeDraft } = useWorkspace();
  const tasks = useStore(rt.tasks);
  const task = tasks.items.find((t) => t.id === payload.task_id);

  useEffect(() => {
    if (!task && !tasks.loading) void rt.tasks.refresh();
    // Only when the task is missing from a finished load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload.task_id, tasks.loading]);

  const origin = task?.origin;
  return (
    <div data-testid="drafts-card" className="card drafts-card">
      <div className="drafts-head">
        {payload.drafts.length === 1 ? "A reply" : `${payload.drafts.length} replies`}
        {origin ? ` you could send ${origin.chat_name}` : ""}
      </div>
      <ol className="drafts">
        {payload.drafts.map((d, i) => (
          <li key={i} data-testid="draft-item" className="draft">
            <div className="draft-text">{d.text}</div>
            <div className="draft-actions">
              {task?.state === "done" && task.sent_draft_index === i && <span className="sent-mark">Sent</span>}
              <button
                data-testid="draft-use"
                className="pill-btn small approve"
                disabled={!origin}
                title={origin ? `Put this draft into ${origin.chat_name}` : "Loading task…"}
                onClick={() => origin && placeDraft(origin.room_id, d.text, payload.task_id, i)}
              >
                Use
              </button>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
