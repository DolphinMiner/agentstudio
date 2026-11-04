// Preload (sandboxed): exposes the narrow window.agentStudioDesktop API.

import { contextBridge, ipcRenderer } from "electron";
import type { NotifyTarget, Session } from "@agentstudio/core";
import { IPC, type DesktopInfo, type AgentStudioDesktop } from "../shared/desktop-api";

const info = ipcRenderer.sendSync(IPC.info) as DesktopInfo;

const api: AgentStudioDesktop = {
  version: info.version,
  platform: info.platform,
  getServerUrl: () => info.serverUrl,
  serverUrlFromEnv: () => info.serverUrlFromEnv,
  emailSignInOnly: () => info.emailSignInOnly,
  setServerUrl: (url: string) => ipcRenderer.invoke(IPC.setServerUrl, url),
  session: {
    load: () => ipcRenderer.invoke(IPC.sessionLoad) as Promise<Session | null>,
    save: (s: Session) => ipcRenderer.invoke(IPC.sessionSave, s),
    clear: () => ipcRenderer.invoke(IPC.sessionClear),
  },
  notifications: {
    show: (n) => ipcRenderer.send(IPC.notify, n),
    setBadge: (count) => ipcRenderer.send(IPC.badge, count),
    prefs: () => ipcRenderer.invoke(IPC.notifyPrefs, "get"),
    setEnabled: (enabled) => ipcRenderer.invoke(IPC.notifyPrefs, "enabled", enabled),
    setAgentMode: (agentId, mode) => ipcRenderer.invoke(IPC.notifyPrefs, "agent", agentId, mode),
    openSystemSettings: () => ipcRenderer.invoke(IPC.notifyPrefs, "system-settings"),
    onClick: (cb) => {
      // The main process keeps the last click until the renderer takes it, so a
      // click that happens before the workspace is up is not lost.
      const take = () =>
        void (ipcRenderer.invoke(IPC.notifyTakeClick) as Promise<NotifyTarget | null>).then((t) => {
          if (t) cb(t);
        });
      ipcRenderer.on(IPC.notifyClicked, take);
      take();
      return () => {
        ipcRenderer.removeListener(IPC.notifyClicked, take);
      };
    },
  },
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
  exportDiagnostics: () => ipcRenderer.invoke(IPC.exportDiagnostics),
  connectors: {
    services: () => ipcRenderer.invoke(IPC.connectors, "services"),
    list: () => ipcRenderer.invoke(IPC.connectors, "list"),
    begin: (service) => ipcRenderer.invoke(IPC.connectors, "begin", service),
    progress: (loginId) => ipcRenderer.invoke(IPC.connectors, "progress", loginId),
    choose: (loginId, choiceId) => ipcRenderer.invoke(IPC.connectors, "choose", loginId, choiceId),
    submit: (loginId, value) => ipcRenderer.invoke(IPC.connectors, "submit", loginId, value),
    cancel: (loginId) => ipcRenderer.invoke(IPC.connectors, "cancel", loginId),
    remove: (id) => ipcRenderer.invoke(IPC.connectors, "remove", id),
    attach: (id, connectionId) => ipcRenderer.invoke(IPC.connectors, "attach", id, connectionId),
    open: (id) => ipcRenderer.invoke(IPC.connectors, "open", id),
  },
};

contextBridge.exposeInMainWorld("agentStudioDesktop", api);
