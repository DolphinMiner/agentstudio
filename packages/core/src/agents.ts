// Agents list, polled like approvals. The inbox uses it for agent rows.

import type { ApiClient } from "./api.js";
import { PollingList, type PollingOptions } from "./polling.js";
import type { Agent } from "./types.js";

/** Agents list (polled), used by the inbox for status and "Needs you". */
export class AgentsStore extends PollingList<Agent> {
  constructor(
    private readonly api: ApiClient,
    opts: PollingOptions = {},
  ) {
    super(() => api.agents(), opts);
  }

  byRoomId(roomId: string): Agent | undefined {
    return this.items.find((a) => a.room_id === roomId);
  }

  async setConsent(agentId: string, askWithoutPreview: boolean): Promise<Agent> {
    const a = await this.api.setAgentConsent(agentId, askWithoutPreview);
    this.upsert(a);
    return a;
  }
}
