// Pure UI logic, free of React Native imports (unit tested in test/logic.test.ts).

import type { Agent, ChatRow, Task, TaskState } from "@agentstudio/core";

/** Board column for a task state; cancelled and failed tasks go to "done". */
export type TaskColumn = "pending" | "answered" | "done";

export function taskColumn(state: TaskState): TaskColumn {
  if (state === "pending") return "pending";
  if (state === "answered") return "answered";
  return "done";
}

export function groupTasks(tasks: readonly Task[]): Record<TaskColumn, Task[]> {
  const out: Record<TaskColumn, Task[]> = { pending: [], answered: [], done: [] };
  for (const t of tasks) out[taskColumn(t.state)].push(t);
  for (const col of Object.values(out)) col.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return out;
}

/** Agents that can take an "Ask an agent" request (they need a room). */
export function askableAgents(agents: readonly Agent[]): Agent[] {
  return agents.filter((a) => a.room_id && a.capabilities.includes("ask"));
}

/** Text placed in a composer by a draft's "Use" button, remembered per room. */
export type ComposerDraft = {
  text: string;
  /** Set when the text came from an agent draft; sending it marks the task sent. */
  fromDraft: { taskId: string; draftIndex: number } | null;
};

/** One-line preview under a chat row's name. */
export function rowPreview(row: Pick<ChatRow, "lastMessage" | "lastOwn">): string {
  if (!row.lastMessage) return "";
  const text = row.lastMessage.replace(/\s+/g, " ").trim();
  return row.lastOwn ? `You: ${text}` : text;
}

/** Up to two initials for an avatar ("Leo Park" -> "LP", "+1 555" -> "#"). */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => /^\p{L}/u.test(w));
  if (words.length === 0) return "#";
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/** Short time label: clock time today, weekday this week, else month/day. */
export function formatTime(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  const days = Math.floor((now - ts) / 86_400_000);
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Badge text for a count (caps at 99+). */
export function badgeText(n: number): string {
  return n > 99 ? "99+" : String(n);
}
