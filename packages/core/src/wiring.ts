// Glue: refresh REST-backed stores when AgentStudio custom messages arrive.

import type { AgentStudioMatrix } from "./matrix.js";
import type { Unsubscribe } from "./store.js";

type Triggerable = { trigger(): void };
type CountedList = Triggerable & { subscribe(l: () => void): Unsubscribe; readonly pendingCount: number };

/**
 * - com.agentstudio.approval: refresh approvals and agents (pending counts)
 * - com.agentstudio.drafts: refresh tasks (the task became "answered")
 * - the pending approvals count changed (e.g. the user decided): refresh agents,
 *   so "Needs you" and the agent's pending count clear at once, not on the next poll
 * Returns an unsubscribe function.
 */
export function connectStores(
  matrix: Pick<AgentStudioMatrix, "onAgentStudioEvent">,
  stores: { approvals?: Triggerable | CountedList; tasks?: Triggerable; agents?: Triggerable },
): Unsubscribe {
  const approvals = stores.approvals;
  let unsubCount: Unsubscribe = () => {};
  if (stores.agents && approvals && "subscribe" in approvals) {
    let last = approvals.pendingCount;
    unsubCount = approvals.subscribe(() => {
      if (approvals.pendingCount !== last) {
        last = approvals.pendingCount;
        stores.agents?.trigger();
      }
    });
  }
  const unsubEvents = matrix.onAgentStudioEvent((kind) => {
    if (kind === "approval") {
      stores.approvals?.trigger();
      stores.agents?.trigger();
    } else if (kind === "drafts") {
      stores.tasks?.trigger();
      stores.agents?.trigger();
    }
  });
  return () => {
    unsubCount();
    unsubEvents();
  };
}
