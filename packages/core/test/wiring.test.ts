import { describe, expect, it, vi } from "vitest";
import { connectStores } from "../src/wiring.js";
import { Store } from "../src/store.js";

function fakeApprovals(count: number) {
  const state = new Store({ count });
  return {
    trigger: vi.fn(),
    subscribe: state.subscribe,
    get pendingCount() {
      return state.getSnapshot().count;
    },
    set: (n: number) => state.set({ count: n }),
  };
}

describe("connectStores", () => {
  it("refreshes agents when the pending approvals count changes", () => {
    const approvals = fakeApprovals(1);
    const agents = { trigger: vi.fn() };
    const matrix = { onAgentStudioEvent: () => () => {} };
    const unsub = connectStores(matrix, { approvals, agents });

    approvals.set(1); // same count: no refresh
    expect(agents.trigger).not.toHaveBeenCalled();
    approvals.set(0); // the user decided
    expect(agents.trigger).toHaveBeenCalledTimes(1);

    unsub();
    approvals.set(2);
    expect(agents.trigger).toHaveBeenCalledTimes(1);
  });

  it("refreshes approvals and agents on an approval event", () => {
    let emit: (kind: string) => void = () => {};
    const matrix = {
      onAgentStudioEvent: (cb: (kind: string) => void) => {
        emit = cb;
        return () => {};
      },
    };
    const approvals = { trigger: vi.fn() };
    const agents = { trigger: vi.fn() };
    connectStores(matrix as never, { approvals, agents });
    emit("approval");
    expect(approvals.trigger).toHaveBeenCalledTimes(1);
    expect(agents.trigger).toHaveBeenCalledTimes(1);
  });
});
