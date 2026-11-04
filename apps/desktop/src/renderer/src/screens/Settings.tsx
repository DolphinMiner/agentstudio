import { useState } from "react";
import { AGENT_NOTIFY_MODES, agentNotifyMode, type AgentNotifyMode } from "@agentstudio/core";
import { desktop } from "../lib/desktop";
import { errorText } from "../lib/errors";
import { useStore } from "../lib/hooks";
import { AGENT_MODE_LABELS, notificationPrefs, setAgentNotifyMode, setNotificationsEnabled } from "../lib/notifications";
import { serverUrl, sessions } from "../lib/services";
import { useWorkspace } from "../lib/workspace";

export function SettingsScreen() {
  const { session, rt } = useWorkspace();
  const prefs = useStore(notificationPrefs);
  const agents = useStore(rt.agents).items;
  const [url, setUrl] = useState(serverUrl);
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  async function exportDiagnostics() {
    try {
      const file = await desktop.exportDiagnostics();
      if (file) setExported(file);
    } catch (e) {
      setError(errorText(e));
    }
  }
  const [busy, setBusy] = useState(false);
  const fromEnv = desktop.serverUrlFromEnv();

  async function saveServer() {
    setError(null);
    setBusy(true);
    try {
      // A different server means a different account: sign out first.
      await sessions.logout();
      await desktop.setServerUrl(url);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="display">Settings</h1>
      </header>
      <div className="page-scroll">
        <div className="settings">
          <section className="settings-group">
            <div className="settings-row">
              <span className="settings-label">Account</span>
              <span data-testid="settings-email">
                {/* The local-mode account (server: LocalEmail) belongs to whoever uses this Mac. */}
                {session.user.email === "you@agentstudio.local" ? "You, on this Mac" : session.user.email}
              </span>
            </div>
            <div className="settings-row">
              <span className="settings-label">Server</span>
              <div className="settings-value">
                <input
                  data-testid="settings-server"
                  value={url}
                  readOnly={fromEnv}
                  onChange={(e) => setUrl(e.target.value)}
                  spellCheck={false}
                />
                {fromEnv ? (
                  <span className="muted small">Set by AGENTSTUDIO_SERVER_URL</span>
                ) : (
                  url.trim() !== serverUrl && (
                    <button className="btn small" disabled={busy} onClick={() => void saveServer()}>
                      Save and sign out
                    </button>
                  )
                )}
              </div>
            </div>
            {error && <p className="error small">{error}</p>}
            <div className="settings-row">
              <span className="settings-label">Version</span>
              <span data-testid="settings-version">{desktop.version}</span>
            </div>
          </section>
          <section className="settings-group" aria-label="Notifications">
            <div className="settings-row">
              <label className="settings-label" htmlFor="settings-notifications">
                System notifications
              </label>
              <span className="settings-value muted small">When an agent needs you, replies or has a problem, and when people write.</span>
              <input
                id="settings-notifications"
                data-testid="settings-notifications"
                type="checkbox"
                role="switch"
                className="switch"
                checked={prefs.enabled}
                onChange={(e) => void setNotificationsEnabled(e.target.checked)}
              />
            </div>
            {prefs.enabled && desktop.platform === "darwin" && (
              <p className="settings-note muted small">
                Nothing showing up?{" "}
                <button className="btn quiet small" onClick={() => void desktop.notifications.openSystemSettings()}>
                  Allow AgentStudio in System Settings
                </button>
              </p>
            )}
            {agents.map((a) => (
              <div className="settings-row" key={a.id}>
                <span className="settings-label">{a.name}</span>
                <div className="settings-value">
                  <select
                    data-testid="settings-agent-notify"
                    data-agent-name={a.name}
                    aria-label={`Notifications from ${a.name}`}
                    value={agentNotifyMode(prefs, a.id)}
                    disabled={!prefs.enabled}
                    onChange={(e) => void setAgentNotifyMode(a.id, e.target.value as AgentNotifyMode)}
                  >
                    {AGENT_NOTIFY_MODES.map((m) => (
                      <option key={m} value={m}>
                        {AGENT_MODE_LABELS[m]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ))}
          </section>
          <section className="settings-group" aria-label="Help">
            <div className="settings-row">
              <span className="settings-label">Diagnostics</span>
              <span className="settings-value muted small">
                {exported ? `Saved to ${exported}` : "A report of connector problems to share when something doesn't work. No messages or passwords."}
              </span>
              <button data-testid="settings-export-diagnostics" className="btn quiet small" onClick={() => void exportDiagnostics()}>
                Export…
              </button>
            </div>
          </section>
          <button data-testid="settings-signout" className="btn danger" onClick={() => void sessions.logout()}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
