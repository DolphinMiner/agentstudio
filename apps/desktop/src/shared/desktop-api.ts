// The bridge between the sandboxed renderer and the Electron main process.
// The preload exposes an object of this shape as `window.agentStudioDesktop`.

import type { AgentNotifyMode, NotificationPrefs, NotifyTarget, Session } from "@agentstudio/core";
import type { DesktopNotification } from "./notifications";

/** Agents reached through the user's own signed-in session, running on this Mac (Muse, Grok Bot, Dots). */
export type LocalServiceId = "grokbot" | "muse" | "dots" | "cue";
export type LocalService = { id: LocalServiceId; name: string; description: string };
export type LocalConnector = {
  id: string;
  service: LocalServiceId;
  name: string;
  status: "ready" | "needs_login" | "starting" | "reconnecting" | "error";
  message?: string;
  url: string;
  canOpen: boolean;
  /** The agents-bridge connection this connector was registered as. */
  connectionId?: string;
};
export type LocalLoginProgress =
  /** actions: buttons the user can press meanwhile; answer with choose(loginId, id). */
  | { state: "waiting"; message: string; actions?: { id: string; label: string }[] }
  | { state: "choose"; message: string; choices: { id: string; label: string }[] }
  | { state: "input"; message: string; label: string; secret: boolean; link?: { label: string; url: string }; error?: string }
  | { state: "ready"; instances: { instanceId: string; name: string; url: string; token: string }[] }
  | { state: "failed"; message: string }
  | { state: "cancelled" };

export interface AgentStudioDesktop {
  /** App version, e.g. "0.1.0". */
  readonly version: string;
  /** process.platform of the main process, e.g. "darwin". */
  readonly platform: string;
  /** Effective server URL: env AGENTSTUDIO_SERVER_URL, then the saved setting, then the default. */
  getServerUrl(): string;
  /** True when AGENTSTUDIO_SERVER_URL is set, so the saved setting is ignored. */
  serverUrlFromEnv(): boolean;
  /** Tests: always sign in with email, even against a local-mode server. */
  emailSignInOnly(): boolean;
  /** Validates and saves the setting, then reloads the window (the CSP depends on it). */
  setServerUrl(url: string): Promise<void>;
  /** Session persisted in a safeStorage-encrypted file in userData. */
  session: {
    load(): Promise<Session | null>;
    save(session: Session): Promise<void>;
    clear(): Promise<void>;
  };
  /** Open an http(s) or mailto URL in the default browser. */
  openExternal(url: string): Promise<void>;
  /** Saves a diagnostics report (no secrets) where the user picks; resolves with the path, or null if cancelled. */
  exportDiagnostics(): Promise<string | null>;
  /** System notifications and the Dock badge. What to notify is decided in @agentstudio/core. */
  notifications: {
    /** Show a notification (unless the master switch is off). Clicking it brings the window forward. */
    show(n: DesktopNotification): void;
    /** The Dock badge; 0 removes it. */
    setBadge(count: number): void;
    /** Saved settings (settings.json in userData). */
    prefs(): Promise<NotificationPrefs>;
    /** The master switch. Turning it on the first time asks macOS for permission. */
    setEnabled(enabled: boolean): Promise<NotificationPrefs>;
    setAgentMode(agentId: string, mode: AgentNotifyMode): Promise<NotificationPrefs>;
    /** Opens System Settings at Notifications. */
    openSystemSettings(): Promise<void>;
    /**
     * Called with where to go when the user clicks a notification, including
     * one clicked before this was registered. Returns an unsubscribe function.
     */
    onClick(cb: (target: NotifyTarget) => void): () => void;
  };
  /** Connectors that run on this Mac. */
  connectors: {
    services(): Promise<LocalService[]>;
    list(): Promise<LocalConnector[]>;
    /** Starts signing in to a service; returns a login id to poll. */
    begin(service: LocalServiceId): Promise<string>;
    progress(loginId: string): Promise<LocalLoginProgress>;
    choose(loginId: string, choiceId: string): Promise<void>;
    /** Answers an "input" step. */
    submit(loginId: string, value: string): Promise<void>;
    cancel(loginId: string): Promise<void>;
    remove(id: string): Promise<void>;
    attach(id: string, connectionId: string): Promise<void>;
    /** Shows the service's own window (Muse, Dots). */
    open(id: string): Promise<void>;
  };
}

/** IPC channel names shared by main and preload. */
export const IPC = {
  info: "agentstudio:info",
  setServerUrl: "agentstudio:set-server-url",
  sessionLoad: "agentstudio:session-load",
  sessionSave: "agentstudio:session-save",
  sessionClear: "agentstudio:session-clear",
  notify: "agentstudio:notify",
  badge: "agentstudio:badge",
  notifyPrefs: "agentstudio:notify-prefs",
  notifyClicked: "agentstudio:notify-clicked",
  notifyTakeClick: "agentstudio:notify-take-click",
  openExternal: "agentstudio:open-external",
  exportDiagnostics: "agentstudio:export-diagnostics",
  connectors: "agentstudio:connectors",
} as const;

export type DesktopInfo = {
  version: string;
  platform: string;
  serverUrl: string;
  serverUrlFromEnv: boolean;
  emailSignInOnly: boolean;
};
