import { useEffect, useState } from "react";
import type { Task } from "@agentstudio/core";
import { errorText } from "../lib/errors";
import { useNow, useStore } from "../lib/hooks";
import { formatTime, groupTasks, type TaskColumn } from "../lib/logic";
import { useWorkspace } from "../lib/workspace";

const COLUMNS: { id: TaskColumn; label: string }[] = [
  { id: "pending", label: "Waiting for agent" },
  { id: "answered", label: "Drafts ready" },
  { id: "done", label: "Done" },
];

const STATE_LABEL: Record<Task["state"], string> = {
  pending: "Pending",
  answered: "Answered",
  done: "Sent",
  cancelled: "Cancelled",
  failed: "Failed",
};

export function TasksScreen() {
  const { rt } = useWorkspace();
  const snap = useStore(rt.tasks);
  const cols = groupTasks(snap.items);
  const now = useNow(60_000);
  useEffect(() => {
    void rt.tasks.refresh();
  }, [rt]);

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="display">Tasks</h1>
        <p className="muted">Things you asked your agents to help with.</p>
      </header>
      <div data-testid="tasks-board" className="board">
        {COLUMNS.map((c) => (
          <section key={c.id} data-testid={`tasks-col-${c.id}`} className="board-col">
            <h3>
              {c.label} <span className="count">{cols[c.id].length}</span>
            </h3>
            <div className="board-cards">
              {cols[c.id].map((t) => (
                <TaskCard key={t.id} task={t} now={now} />
              ))}
              {cols[c.id].length === 0 && <p className="muted small pad">Nothing here.</p>}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function TaskCard({ task, now }: { task: Task; now: number }) {
  const { rt, openRoom } = useWorkspace();
  const [error, setError] = useState<string | null>(null);
  const agent = rt.agents.get(task.agent_id);
  const target = task.state === "answered" ? agent?.room_id : task.origin.room_id;
  return (
    <div data-testid="task-card" data-state={task.state} className="card task-card">
      <button className="task-open" disabled={!target} onClick={() => target && openRoom(target)}>
        <div className="card-title small-title">{task.title || task.request_text}</div>
        <div className="muted small">
          {task.agent_name} · {task.origin.chat_name} · {formatTime(Date.parse(task.updated_at), now)}
        </div>
        <div className="muted small">“{task.request_text}”</div>
      </button>
      <div className="task-foot">
        <span className={`pill pill-${task.state}`}>{STATE_LABEL[task.state]}</span>
        {(task.state === "pending" || task.state === "answered") && (
          <button
            className="btn link small"
            onClick={() => rt.tasks.cancel(task.id).catch((e) => setError(errorText(e)))}
          >
            Cancel
          </button>
        )}
      </div>
      {error && <div className="error small">{error}</div>}
    </div>
  );
}
