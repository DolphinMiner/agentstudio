// Pure UI logic (unit tested in test/logic.web.test.ts).

import type { Agent, Task, TaskState } from "@agentstudio/core";
import type { LocalConnector } from "../../../shared/desktop-api";
import type { MarkId } from "../components/Mark";

export type View = "inbox" | "approvals" | "tasks" | "connect" | "settings";

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

/** Day label for timeline separators. */
export function formatTime(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  const sameDay = d.toDateString() === n.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = Math.floor((now - ts) / 86_400_000);
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** The small corner mark for an agent's service (the Muse squiggle, the Grok Bot icon, ChatGPT). */
export function agentBadge(agent: Pick<Agent, "connection_id" | "name" | "description"> | undefined, local: Pick<LocalConnector, "connectionId" | "service">[]): MarkId | null {
  const m = agentMark(agent, local);
  return m === "muse" ? "muse-mark" : m;
}

/** Well-known agents reached over an open protocol (A2A, ACP), told apart by their name or description. */
const KNOWN_AGENTS: [RegExp, MarkId][] = [
  [/\bhermes\b/i, "hermes"],
  [/\bopen\s?claw\b|\bclawdbot\b|\bmoltbot\b/i, "openclaw"],
];

/** The mark to show for an agent: its local service, a well-known agent, the concierge, or none. */
export function agentMark(agent: Pick<Agent, "connection_id" | "name" | "description"> | undefined, local: Pick<LocalConnector, "connectionId" | "service">[]): MarkId | null {
  if (!agent) return null;
  const c = local.find((l) => l.connectionId === agent.connection_id);
  if (c) return c.service;
  if (agent.name === "Concierge") return "concierge";
  const known = KNOWN_AGENTS.find(([re]) => re.test(agent.name) || re.test(agent.description ?? ""));
  return known ? known[1] : null;
}
