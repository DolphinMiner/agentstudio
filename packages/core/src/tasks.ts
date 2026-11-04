// Tasks ("Ask an agent"): list store plus create / sent / cancel with version
// conflict handling.

import { ApiError, isApiError, type ApiClient, type CreateTaskInput } from "./api.js";
import { newIdempotencyKey } from "./platform.js";
import { PollingList, type PollingOptions } from "./polling.js";
import type { Task, TaskOrigin, TaskState } from "./types.js";

export type TasksStoreOptions = PollingOptions & {
  /** Which tasks to list (default "all", so the board can show done tasks). */
  state?: "open" | "all";
};

export class TasksStore extends PollingList<Task> {
  constructor(
    private readonly api: ApiClient,
    opts: TasksStoreOptions = {},
  ) {
    super(() => api.tasks(opts.state ?? "all"), opts);
  }

  byState(state: TaskState): Task[] {
    return this.items.filter((t) => t.state === state);
  }

  /** Create a task (idempotent: the same key is reused on a network retry). */
  async create(agentId: string, requestText: string, origin: TaskOrigin, title?: string): Promise<Task> {
    const input: CreateTaskInput = {
      agent_id: agentId,
      idempotency_key: newIdempotencyKey(),
      request_text: requestText,
      origin,
      ...(title ? { title } : {}),
    };
    let task: Task;
    try {
      task = await this.api.createTask(input);
    } catch (e) {
      if (!isApiError(e, "network_error") && !isApiError(e, "timeout")) throw e;
      task = await this.api.createTask(input);
    }
    this.upsert(task);
    return task;
  }

  /** The user sent draft `draftIndex` back to the origin chat. */
  markSent(taskId: string, draftIndex: number): Promise<Task> {
    return this.mutate(taskId, "done", (version) =>
      this.api.markTaskSent(taskId, { version, draft_index: draftIndex }),
    );
  }

  cancel(taskId: string): Promise<Task> {
    return this.mutate(taskId, "cancelled", (version) => this.api.cancelTask(taskId, { version }));
  }

  private async mutate(
    taskId: string,
    target: TaskState,
    call: (version: number) => Promise<Task>,
  ): Promise<Task> {
    let task = this.get(taskId);
    if (!task) {
      await this.refresh();
      task = this.get(taskId);
      if (!task) throw new ApiError(404, "not_found", "Task not found");
    }
    let result: Task;
    try {
      result = await call(task.version);
    } catch (e) {
      if (!(e instanceof ApiError && e.isConflict && isTask(e.current))) throw e;
      const current = e.current;
      this.upsert(current);
      if (current.state === target) return current; // already done elsewhere
      if (current.state !== "pending" && current.state !== "answered") throw e;
      result = await call(current.version);
    }
    this.upsert(result);
    return result;
  }
}

function isTask(v: unknown): v is Task {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as Task).id === "string" &&
    typeof (v as Task).version === "number"
  );
}
