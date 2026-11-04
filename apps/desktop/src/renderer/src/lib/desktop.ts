// Access to the preload API. In a plain browser (e.g. vite preview without
// Electron) a memory-only fallback keeps the UI usable for development.

import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefs, type Session } from "@agentstudio/core";
import { DEFAULT_SERVER_URL } from "../../../shared/config";
import type { AgentStudioDesktop } from "../../../shared/desktop-api";

declare global {
  interface Window {
    agentStudioDesktop?: AgentStudioDesktop;
  }
}

function browserFallback(): AgentStudioDesktop {
  let session: Session | null = null;
  let prefs: NotificationPrefs = DEFAULT_NOTIFICATION_PREFS;
  return {
    version: "dev",
    platform: "web",
    getServerUrl: () => DEFAULT_SERVER_URL,
    serverUrlFromEnv: () => false,
    emailSignInOnly: () => false,
    setServerUrl: async () => {},
    session: {
      load: async () => session,
      save: async (s) => {
        session = s;
      },
      clear: async () => {
        session = null;
      },
    },
    notifications: {
      show: () => {},
      setBadge: () => {},
      prefs: async () => prefs,
      setEnabled: async (enabled) => (prefs = { ...prefs, enabled }),
      setAgentMode: async (agentId, mode) => (prefs = { ...prefs, agents: { ...prefs.agents, [agentId]: mode } }),
      openSystemSettings: async () => {},
      onClick: () => () => {},
    },
    exportDiagnostics: async () => null,
    openExternal: async (url) => {
      window.open(url, "_blank", "noopener");
    },
    connectors: {
      services: async () => [],
      list: async () => [],
      begin: async () => {
        throw new Error("Connectors need the AgentStudio Mac app");
      },
      progress: async () => ({ state: "failed", message: "Connectors need the AgentStudio Mac app" }),
      choose: async () => {},
      submit: async () => {},
      cancel: async () => {},
      remove: async () => {},
      attach: async () => {},
      open: async () => {},
    },
  };
}

export const desktop: AgentStudioDesktop = window.agentStudioDesktop ?? browserFallback();
