import { useEffect, useRef, useState, type FormEvent } from "react";
import type { LocalConnector, LocalLoginProgress, LocalServiceId } from "../../../shared/desktop-api";
import { desktop } from "../lib/desktop";
import { errorText } from "../lib/errors";
import { refreshLocalConnectors, useLocalConnectors } from "../lib/marks";
import { useStore } from "../lib/hooks";
import { api } from "../lib/services";
import { useWorkspace } from "../lib/workspace";
import { RoomAvatar } from "./Avatar";
import { Icon } from "./Icon";
import { Mark } from "./Mark";

const AGENTS_NETWORK = "agentstudio-agents";

// Muse and Dots keep their sign-in in browser cookies, which apps can't read, so
// they sign in in an AgentStudio window instead of the browser.
const SERVICES: { id: LocalServiceId; name: string; blurb: string; site?: string }[] = [
  { id: "grokbot", name: "Grok Bot", blurb: "Sign in with your Cursor account in the browser." },
  {
    id: "muse",
    name: "Muse",
    site: "Muse",
    blurb: "Sign in to muse.ai in an AgentStudio window. Your browser's sign-in can't be shared with apps, so it happens here once.",
  },
  {
    id: "dots",
    name: "ChatGPT Dots",
    site: "ChatGPT",
    blurb: "Sign in to ChatGPT in an AgentStudio window. Your browser's sign-in can't be shared with apps, so it happens here once.",
  },
  { id: "cue", name: "Cue", blurb: "Sign in with your Manus account (or use an API key). Every agent of your account comes along." },
];

const STATUS_TEXT: Record<LocalConnector["status"], string> = {
  ready: "Connected",
  starting: "Starting",
  needs_login: "Sign in again",
  error: "Problem",
  reconnecting: "Reconnecting…",
};

/**
 * Agents reached through the user's own signed-in session, running in this
 * app (Muse, Grok Bot, ChatGPT Dots). Connecting signs in to the service, then
 * registers the local connector with the agents bridge like any agent endpoint.
 */
export function LocalAgents({ onConnected }: { onConnected: () => void }) {
  const local = useLocalConnectors();
  const [busy, setBusy] = useState<LocalServiceId | null>(null);
  const [progress, setProgress] = useState<LocalLoginProgress | null>(null);
  const [error, setError] = useState<{ service: LocalServiceId; text: string } | null>(null);
  const loginRef = useRef<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  // Said once, after the first agent connects: these agents live on this Mac.
  const [noteSeen, setNoteSeen] = useState(() => localStorage.getItem("agentstudio.localModeNote") === "1");
  /** The service whose agents are shown in the sheet. */
  const [manage, setManage] = useState<LocalServiceId | null>(null);
  const { rt } = useWorkspace();
  const agents = useStore(rt.agents);
  const roomOf = (c: LocalConnector) => agents.items.find((a) => a.connection_id === c.connectionId)?.room_id ?? null;

  function submitInput(e: FormEvent) {
    e.preventDefault();
    const id = loginRef.current;
    if (!id || !inputValue.trim()) return;
    void desktop.connectors.submit(id, inputValue.trim());
    setInputValue("");
    setProgress({ state: "waiting", message: "Checking…" });
  }

  /** The agents bridge reaches each local connector through the generic endpoint flow. */
  async function register(inst: Extract<LocalLoginProgress, { state: "ready" }>["instances"][number]) {
    const start = await api.startLogin(AGENTS_NETWORK, "endpoint");
    let step = start.step;
    if (step.type === "user_input") {
      step = await api.submitLoginStep(start.process_id, step.step_id, { fields: { url: inst.url, token: inst.token } });
    }
    if (step.type !== "complete" || !step.complete) throw new Error(`The agents bridge didn't accept ${inst.name}`);
    await desktop.connectors.attach(inst.instanceId, step.complete.connection_id);
  }

  async function connect(service: LocalServiceId) {
    setError(null);
    setBusy(service);
    setProgress({ state: "waiting", message: "Starting…" });
    try {
      const loginId = await desktop.connectors.begin(service);
      loginRef.current = loginId;
      for (;;) {
        await new Promise((r) => setTimeout(r, 600));
        if (loginRef.current !== loginId) return; // cancelled from the UI
        const p = await desktop.connectors.progress(loginId);
        setProgress(p);
        if (p.state === "ready") {
          // A Grok Bot account brings all of its bots at once.
          for (const [i, inst] of p.instances.entries()) {
            setProgress({ state: "waiting", message: p.instances.length > 1 ? `Adding ${inst.name} (${i + 1} of ${p.instances.length})…` : "Connecting…" });
            try {
              await register(inst);
            } catch (e) {
              await desktop.connectors.remove(inst.instanceId).catch(() => {});
              throw e;
            }
          }
          if (p.instances.length === 0) throw new Error("All of this account's bots are already connected.");
          onConnected();
          break;
        }
        if (p.state === "failed") throw new Error(p.message);
        if (p.state === "cancelled") break;
      }
    } catch (e) {
      setError({ service, text: errorText(e) });
    } finally {
      loginRef.current = null;
      setBusy(null);
      setProgress(null);
      void refreshLocalConnectors();
    }
  }

  async function cancel() {
    const id = loginRef.current;
    loginRef.current = null;
    if (id) await desktop.connectors.cancel(id).catch(() => {});
    setBusy(null);
    setProgress(null);
  }

  async function remove(c: LocalConnector) {
    setError(null);
    try {
      if (c.connectionId) await api.deleteConnection(c.connectionId).catch(() => {});
      await desktop.connectors.remove(c.id);
      onConnected();
      await refreshLocalConnectors();
    } catch (e) {
      setError({ service: c.service, text: errorText(e) });
    }
  }

  const managed = manage ? SERVICES.find((s) => s.id === manage)! : null;
  const managedRows = manage ? local.filter((c) => c.service === manage) : [];
  // The sheet closes itself when its last agent is removed.
  useEffect(() => {
    if (manage && managedRows.length === 0) setManage(null);
  }, [manage, managedRows.length]);

  return (
    <section className="catalog-section" data-testid="local-agents">
      <div className="section-head">
        <h2 className="display">Agents you already use</h2>
        <p className="muted">
          AgentStudio signs in with your own account, on this Mac. Your sign-in stays here, and these agents answer while
          AgentStudio is open.
        </p>
        <p className="muted small-print" data-testid="local-agents-notice">
          For personal use with your own accounts. AgentStudio isn't affiliated with these services, works the way their own
          apps do, and may stop working when they change. You're responsible for following each service's terms.
        </p>
      </div>
      {local.length > 0 && !noteSeen && (
        <div className="local-note" role="note" data-testid="local-mode-note">
          <p>
            These agents run in AgentStudio on this Mac. When you quit AgentStudio or the Mac sleeps, they pause until
            AgentStudio is open again.
          </p>
          <button
            className="btn quiet small"
            data-testid="local-mode-note-ok"
            onClick={() => {
              localStorage.setItem("agentstudio.localModeNote", "1");
              setNoteSeen(true);
            }}
          >
            Got it
          </button>
        </div>
      )}
      <ul className="catalog">
        {SERVICES.map((s) => {
          const connected = local.filter((c) => c.service === s.id);
          const active = busy === s.id;
          const trouble = connected.filter((c) => c.status === "needs_login" || c.status === "error").length;
          const reconnecting = connected.filter((c) => c.status === "reconnecting").length;
          return (
            <li key={s.id} className={`catalog-item${active ? " active" : ""}`} data-testid={`local-service-card-${s.id}`}>
              <div className="catalog-row">
                <Mark id={s.id} size={52} />
                <div className="catalog-text">
                  <div className="catalog-name">{s.name}</div>
                  {connected.length === 0 ? (
                    <div className="catalog-blurb">{s.blurb}</div>
                  ) : (
                    <div className={`catalog-blurb state-${trouble ? "needs_login" : "ready"}`} data-testid={`local-service-summary-${s.id}`}>
                      <span className="state-dot" />
                      {connected.length === 1 ? (connected[0]!.name === s.name ? "Connected" : connected[0]!.name) : `${connected.length} agents`}
                      {trouble > 0 && ` · ${trouble} need${trouble === 1 ? "s" : ""} attention`}
                      {reconnecting > 0 && " · reconnecting…"}
                    </div>
                  )}
                </div>
                {connected.length === 0 ? (
                  <button data-testid={`local-service-${s.id}`} className="pill-btn soft" disabled={busy !== null} onClick={() => void connect(s.id)}>
                    {active ? "Connecting…" : "Connect"}
                  </button>
                ) : (
                  <button
                    className="agent-pile-btn"
                    data-testid={`local-service-manage-${s.id}`}
                    aria-label={`Manage ${s.name} agents`}
                    disabled={active}
                    onClick={() => setManage(s.id)}
                  >
                    <span className="agent-pile" aria-hidden>
                      {connected.slice(0, 4).map((c) => (
                        <RoomAvatar key={c.id} roomId={roomOf(c)} name={c.name} agent mark={s.id} size={28} />
                      ))}
                      {connected.length > 4 && <span className="agent-pile-more">+{connected.length - 4}</span>}
                    </span>
                    <Icon name="chevron" />
                  </button>
                )}
              </div>
              {active && progress && (
                <div className="catalog-progress" data-testid="local-login">
                  {progress.state === "input" ? (
                    <form className="input-step" onSubmit={submitInput}>
                      <p data-testid="local-login-status">{progress.message}</p>
                      {progress.link && (
                        <button type="button" className="btn quiet small" data-testid="local-login-link" onClick={() => void desktop.openExternal(progress.link!.url)}>
                          {progress.link.label}
                        </button>
                      )}
                      <div className="input-row">
                        <input
                          data-testid="local-login-input"
                          type={progress.secret ? "password" : "text"}
                          aria-label={progress.label}
                          placeholder={progress.label}
                          value={inputValue}
                          autoFocus
                          autoComplete="off"
                          spellCheck={false}
                          onChange={(e) => setInputValue(e.target.value)}
                        />
                        <button type="submit" className="pill-btn soft" data-testid="local-login-submit" disabled={!inputValue.trim()}>
                          Connect
                        </button>
                      </div>
                      {progress.error && (
                        <p className="catalog-error" role="alert" data-testid="local-login-input-error">
                          {progress.error}
                        </p>
                      )}
                    </form>
                  ) : progress.state === "choose" ? (
                    <>
                      <p data-testid="local-login-status">{progress.message}</p>
                      <div className="choice-list">
                        {progress.choices.map((c) => (
                          <button
                            key={c.id}
                            className="pill-btn soft"
                            data-testid={`local-login-choice-${c.id}`}
                            onClick={() => loginRef.current && void desktop.connectors.choose(loginRef.current, c.id)}
                          >
                            {c.label}
                          </button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <>
                      <p data-testid="local-login-status" className="waiting">
                        <span className="spinner" aria-hidden />
                        {progress.state === "waiting" ? progress.message : progress.state === "ready" ? "Connecting…" : ""}
                      </p>
                      {progress.state === "waiting" &&
                        progress.actions?.map((a) => (
                          <button
                            key={a.id}
                            className="btn quiet small"
                            data-testid={`local-login-action-${a.id}`}
                            onClick={() => loginRef.current && void desktop.connectors.choose(loginRef.current, a.id)}
                          >
                            {a.label}
                          </button>
                        ))}
                    </>
                  )}
                  <button className="btn quiet small" data-testid="local-login-cancel" onClick={() => void cancel()}>
                    Cancel
                  </button>
                </div>
              )}
              {error?.service === s.id && (
                <p className="catalog-error" role="alert" data-testid="local-login-error">
                  {error.text}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      {managed && (
        <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && setManage(null)}>
          <div className="modal sheet agent-sheet" role="dialog" aria-modal="true" aria-labelledby="agent-sheet-title" data-testid="local-sheet">
            <div className="sheet-head">
              <Mark id={managed.id} size={40} />
              <h2 id="agent-sheet-title" className="display">
                {managed.name}
                <span className="sheet-count">{managedRows.length === 1 ? "1 agent" : `${managedRows.length} agents`}</span>
              </h2>
              <button className="icon-btn" aria-label="Close" data-testid="local-sheet-close" onClick={() => setManage(null)}>
                <Icon name="close" />
              </button>
            </div>
            <ul className="agent-list">
              {managedRows.map((c) => (
                <li key={c.id} data-testid="local-connector-row" data-service={c.service} data-status={c.status} className="agent-list-row">
                  <RoomAvatar roomId={roomOf(c)} name={c.name} agent mark={managed.id} size={40} />
                  <div className="catalog-text">
                    <div className="catalog-name">{c.name}</div>
                    <div className={`catalog-blurb state-${c.status}`}>
                      <span className="state-dot" />
                      {STATUS_TEXT[c.status]}
                      {c.message && c.status !== "ready" ? `: ${c.message}` : ""}
                    </div>
                  </div>
                  <div className="row-actions">
                    {c.canOpen && (
                      <button
                        data-testid="local-connector-open"
                        className="pill-btn quiet small"
                        title="Opens it in your browser"
                        onClick={() => void desktop.connectors.open(c.id)}
                      >
                        View in {managed.site ?? managed.name}
                      </button>
                    )}
                    <button data-testid="local-connector-remove" className="pill-btn quiet small" onClick={() => void remove(c)}>
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            {(managed.id === "grokbot" || managed.id === "cue") && (
              <div className="modal-actions">
                <button
                  className="pill-btn soft"
                  data-testid="local-sheet-add"
                  disabled={busy !== null}
                  onClick={() => {
                    setManage(null);
                    void connect(managed.id);
                  }}
                >
                  Check for new agents
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
