// Settings (plain JSON) and the session (safeStorage-encrypted) in userData.

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeStorage } from "electron";

export type Settings = {
  serverUrl?: string;
  /** System notifications: the master switch and per-agent modes (see shared/notifications.ts). */
  notifications?: { enabled?: boolean; agents?: Record<string, string>; askedPermission?: boolean };
};

function writeAtomic(path: string, data: string | Buffer) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

export class DesktopStorage {
  private readonly settingsPath: string;
  private readonly sessionPath: string;

  constructor(dir: string) {
    this.settingsPath = join(dir, "settings.json");
    this.sessionPath = join(dir, "session.bin");
  }

  readSettings(): Settings {
    try {
      const v = JSON.parse(readFileSync(this.settingsPath, "utf8")) as unknown;
      return v && typeof v === "object" ? (v as Settings) : {};
    } catch {
      return {};
    }
  }

  writeSettings(s: Settings) {
    writeAtomic(this.settingsPath, JSON.stringify(s, null, 2));
  }

  /** Returns the stored session, or null if missing or unreadable. */
  loadSession(): unknown {
    if (!safeStorage.isEncryptionAvailable()) return null;
    try {
      const buf = readFileSync(this.sessionPath);
      return JSON.parse(safeStorage.decryptString(buf)) as unknown;
    } catch {
      return null;
    }
  }

  saveSession(session: object) {
    if (!safeStorage.isEncryptionAvailable()) {
      // Never write tokens in plain text; the user signs in again next launch.
      console.warn("[agentstudio] safeStorage unavailable; session not persisted");
      return;
    }
    writeAtomic(this.sessionPath, safeStorage.encryptString(JSON.stringify(session)));
  }

  clearSession() {
    rmSync(this.sessionPath, { force: true });
  }
}
