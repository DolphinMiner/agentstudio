// Approvals: the pending list (polled every 15 s and on com.agentstudio.approval
// events), a per-id cache for cards in chat, and decisions with optimistic
// concurrency (version) and idempotency keys.

import { ApiError, isApiError, type ApiClient } from "./api.js";
import { newIdempotencyKey } from "./platform.js";
import { PollingList, type PollingOptions } from "./polling.js";
import { Store } from "./store.js";
import type { Approval } from "./types.js";

export class ApprovalsStore extends PollingList<Approval> {
  /** Every approval we have seen, by id (cards in chat read from here). */
  readonly cards = new Store<Readonly<Record<string, Approval>>>({});
  private loading = new Map<string, Promise<Approval>>();

  constructor(
    private readonly api: ApiClient,
    opts: PollingOptions = {},
  ) {
    super(async () => {
      const list = await api.approvals("pending");
      this.putAll(list);
      return list;
    }, opts);
  }

  get pendingCount(): number {
    return this.items.length;
  }

  getApproval(id: string): Approval | undefined {
    return this.cards.getSnapshot()[id];
  }

  /** Fetch one approval (deduplicated) and cache it. */
  load(id: string): Promise<Approval> {
    let p = this.loading.get(id);
    if (!p) {
      p = this.api
        .approval(id)
        .then((a) => {
          this.put(a);
          return a;
        })
        .finally(() => this.loading.delete(id));
      this.loading.set(id, p);
    }
    return p;
  }

  /**
   * Decide on an approval. On a version conflict the cached copy is replaced
   * with the server's current object; if it is still pending the decision is
   * retried once with the new version, otherwise the ApiError is rethrown (the
   * card then shows the real state). Network failures are retried once with
   * the same idempotency key.
   */
  async decide(id: string, choice: string): Promise<Approval> {
    let current = this.getApproval(id) ?? (await this.load(id));
    let key = newIdempotencyKey();
    const send = async (version: number) => {
      try {
        return await this.api.decideApproval(id, { choice, version, idempotency_key: key });
      } catch (e) {
        if (isApiError(e, "network_error") || isApiError(e, "timeout")) {
          return this.api.decideApproval(id, { choice, version, idempotency_key: key });
        }
        throw e;
      }
    };
    let result: Approval;
    try {
      result = await send(current.version);
    } catch (e) {
      if (e instanceof ApiError && e.isConflict && isApproval(e.current)) {
        current = e.current;
        this.put(current);
        if (current.state !== "pending") {
          this.dropFromPending(current);
          throw e;
        }
        key = newIdempotencyKey();
        result = await send(current.version);
      } else {
        if (isApiError(e, "expired")) void this.load(id).then((a) => this.dropFromPending(a), () => {});
        throw e;
      }
    }
    this.put(result);
    this.dropFromPending(result);
    this.trigger();
    return result;
  }

  private put(a: Approval) {
    this.cards.update((m) => {
      const old = m[a.id];
      if (old && old.version > a.version) return m;
      return { ...m, [a.id]: a };
    });
  }

  private putAll(list: Approval[]) {
    for (const a of list) this.put(a);
  }

  private dropFromPending(a: Approval) {
    if (a.state === "pending") return;
    this.state.update((s) =>
      s.items.some((x) => x.id === a.id) ? { ...s, items: s.items.filter((x) => x.id !== a.id) } : s,
    );
  }
}

function isApproval(v: unknown): v is Approval {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as Approval).id === "string" &&
    typeof (v as Approval).version === "number"
  );
}

/** "44 min left", "1 h 5 min left", "Expired", or null without expiry. */
export function formatExpiry(expiresAt: string | null | undefined, now: number = Date.now()): string | null {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return null;
  const ms = t - now;
  if (ms <= 0) return "Expired";
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return `${mins} min left`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h >= 48) return `${Math.floor(h / 24)} days left`;
  return m ? `${h} h ${m} min left` : `${h} h left`;
}

export function isExpired(a: Approval, now: number = Date.now()): boolean {
  if (a.state === "expired") return true;
  if (a.state !== "pending" || !a.expires_at) return false;
  return Date.parse(a.expires_at) <= now;
}

/**
 * Text of the card's state line (docs/clients.md `approval-state`):
 * "Approved: Book", "Declined: Don't book", "Expired", "Cancelled",
 * or null while pending.
 */
export function approvalStateText(a: Approval, now: number = Date.now()): string | null {
  if (a.state === "decided" && a.decision) {
    const choice = a.choices.find((c) => c.key === a.decision!.choice);
    const label = choice?.label ?? a.decision.choice;
    return choice?.category === "deny" ? `Declined: ${label}` : `Approved: ${label}`;
  }
  if (isExpired(a, now)) return "Expired";
  if (a.state === "cancelled") return "Cancelled";
  return null;
}
