// Persists connector instances (service, local token, the service's own
// sign-in state) in a safeStorage-encrypted file in userData. Without
// safeStorage nothing is written: the user connects again next launch.

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeStorage } from "electron";
import type { ServiceId } from "./types";

export type InstanceRecord = {
  id: string;
  service: ServiceId;
  /** Bearer token the agents bridge uses to reach this instance. */
  token: string;
  name: string;
  createdAt: string;
  /** Connector-specific state (tokens, the chosen bot, ...). */
  data: unknown;
  /** The agents-bridge connection id, once the renderer registered the instance. */
  connectionId?: string;
  /** The bridge's session with this instance, kept so callbacks work right after a restart. */
  bridgeSession?: BridgeSession;
};

export type BridgeSession = { id: string; callbackUrl: string; callbackToken: string };

export class ConnectorStore {
  private readonly path: string;

  constructor(dir: string) {
    this.path = join(dir, "connectors.bin");
  }

  load(): InstanceRecord[] {
    if (!safeStorage.isEncryptionAvailable()) return [];
    try {
      const v = JSON.parse(safeStorage.decryptString(readFileSync(this.path))) as unknown;
      return Array.isArray(v) ? (v as InstanceRecord[]) : [];
    } catch {
      return [];
    }
  }

  save(records: InstanceRecord[]) {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn("[agentstudio] safeStorage unavailable; connectors not persisted");
      return;
    }
    if (records.length === 0) {
      rmSync(this.path, { force: true });
      return;
    }
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(records)), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
