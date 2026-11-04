// Everything that lives while a user is signed in: the Matrix client, the
// REST-backed stores and the inbox model.

import {
  AgentsStore,
  ApprovalsStore,
  InboxStore,
  AgentStudioMatrix,
  TasksStore,
  connectStores,
  type ApiClient,
  type Session,
} from "@agentstudio/core";
import type { ComposerDraft } from "./logic";

export class Runtime {
  readonly matrix: AgentStudioMatrix;
  readonly agents: AgentsStore;
  readonly approvals: ApprovalsStore;
  readonly tasks: TasksStore;
  readonly inbox: InboxStore;
  /** Unsent composer text per room (survives switching rooms). */
  readonly composer = new Map<string, ComposerDraft>();
  private unsubs: (() => void)[] = [];
  private disposed = false;

  constructor(
    readonly api: ApiClient,
    readonly session: Session,
  ) {
    this.matrix = new AgentStudioMatrix({ credentials: session.matrix, initialSyncLimit: 30 });
    this.agents = new AgentsStore(api);
    this.approvals = new ApprovalsStore(api);
    this.tasks = new TasksStore(api);
    this.inbox = new InboxStore({ matrix: this.matrix, agents: this.agents });
  }

  async start(): Promise<void> {
    this.agents.start();
    this.tasks.start();
    this.startApprovalsWhileVisible();
    this.unsubs.push(
      connectStores(this.matrix, { approvals: this.approvals, tasks: this.tasks, agents: this.agents }),
    );
    await this.matrix.start();
    if (this.disposed) this.matrix.stop();
  }

  /** Approvals poll every 15 s only while the window is visible (docs/clients.md). */
  private startApprovalsWhileVisible() {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") this.approvals.stop();
      else this.approvals.start();
    };
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    this.unsubs.push(() => document.removeEventListener("visibilitychange", onVisibility));
  }

  dispose() {
    this.disposed = true;
    for (const u of this.unsubs.splice(0)) u();
    this.inbox.dispose();
    this.agents.stop();
    this.approvals.stop();
    this.tasks.stop();
    this.matrix.stop();
  }
}
