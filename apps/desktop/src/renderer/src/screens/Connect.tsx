import { useCallback, useEffect, useState } from "react";
import type { Connection, LoginStep, Network } from "@agentstudio/core";
import { Icon } from "../components/Icon";
import { LocalAgents } from "../components/LocalAgents";
import { LoginStepView } from "../components/LoginStepView";
import { Mark, type MarkId } from "../components/Mark";
import { errorText } from "../lib/errors";
import { useLocalConnectors } from "../lib/marks";
import { api } from "../lib/services";
import { useWorkspace } from "../lib/workspace";

type LoginState = { network: Network; flowId: string; flowName: string; processId: string; step: LoginStep };

const STATE_TEXT: Record<Connection["state"], string> = {
  connecting: "Connecting",
  connected: "Connected",
  bad_credentials: "Sign in again",
  transient_disconnect: "Reconnecting",
  logged_out: "Logged out",
};

/** Friendlier copy for the bridge's flows; unknown flows use the bridge's own text. */
const FLOW_COPY: Record<string, { name: string; blurb: string; mark: MarkId }> = {
  concierge: { name: "Concierge", blurb: "AgentStudio's sample agent. Ask it for a flight to see an approval.", mark: "concierge" },
  a2a: { name: "A2A agent", blurb: "Any agent that speaks Agent2Agent, like Hermes Agent. Paste its URL.", mark: "a2a" },
  acp: { name: "ACP agent", blurb: "A coding agent that speaks the Agent Client Protocol, run on the server.", mark: "acp" },
  endpoint: { name: "AgentStudio agent endpoint", blurb: "An agent built on the AgentStudio Agent Protocol.", mark: "endpoint" },
  demo: { name: "Demo chats", blurb: "A pretend chat network with a few friends, for trying AgentStudio.", mark: "demo" },
};

const SECTION: Record<string, { title: string; blurb: string }> = {
  "agentstudio-agents": {
    title: "Agents on your server",
    blurb: "Agents that speak an open protocol connect on your AgentStudio server and answer even when this Mac is off.",
  },
  demo: { title: "Chats", blurb: "Bring conversations from your chat accounts into one inbox." },
};

function flowCopy(id: string, fallbackName: string, fallbackBlurb: string, network: Network) {
  return FLOW_COPY[id] ?? { name: fallbackName, blurb: fallbackBlurb, mark: (network.kind === "agent" ? "agents" : "matrix") as MarkId };
}

export function ConnectScreen() {
  const { rt } = useWorkspace();
  const [networks, setNetworks] = useState<Network[] | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [login, setLogin] = useState<LoginState | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const local = useLocalConnectors();

  const loadConnections = useCallback(async () => {
    try {
      setConnections(await api.connections());
    } catch {
      // Keep the last list; the next poll retries.
    }
  }, []);

  useEffect(() => {
    api.networks().then(setNetworks, (e) => setError(errorText(e)));
    void loadConnections();
    const t = setInterval(() => void loadConnections(), 5000);
    return () => clearInterval(t);
  }, [loadConnections]);

  async function startFlow(n: Network, flowId: string, flowName: string) {
    setStarting(flowId);
    setError(null);
    try {
      const r = await api.startLogin(n.id, flowId);
      setLogin({ network: n, flowId, flowName, processId: r.process_id, step: r.step });
      if (r.step.type === "complete") onComplete();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setStarting(null);
    }
  }

  function onComplete() {
    void loadConnections();
    rt.agents.trigger();
    // Show the success state for a moment, then return to the catalog.
    setTimeout(() => setLogin((l) => (l?.step.type === "complete" ? null : l)), 1500);
  }

  async function remove(c: Connection) {
    setError(null);
    try {
      await api.deleteConnection(c.id);
      await loadConnections();
      rt.agents.trigger();
    } catch (e) {
      setError(errorText(e));
    }
  }

  // Agents running on this Mac are listed (and removed) above, with their service.
  const localIds = new Set(local.map((l) => l.connectionId).filter(Boolean));
  const visibleConnections = connections.filter((c) => c.state !== "logged_out" && !localIds.has(c.id));
  // Agents first: that's what AgentStudio is for.
  const ordered = [...(networks ?? [])].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "agent" ? -1 : 1));

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="display">Connect</h1>
        <p className="muted">Bring the agents you use and the people you talk to into one place.</p>
      </header>
      <div className="page-scroll">
        {error && (
          <p className="banner-error" role="alert">
            {error}
          </p>
        )}

        <LocalAgents onConnected={onComplete} />

        {ordered.map((n) => {
          const sec = SECTION[n.id] ?? { title: n.name, blurb: n.kind === "agent" ? "AI agents" : "Chat network" };
          return (
            <section key={n.id} className="catalog-section">
              <div className="section-head" data-testid={`network-${n.id}`}>
                <h2 className="display">{sec.title}</h2>
                <p className="muted">{n.available ? sec.blurb : `${n.name} isn't reachable right now.`}</p>
              </div>
              <ul className="catalog">
                {n.flows.map((f) => {
                  const copy = flowCopy(f.id, f.name, f.description, n);
                  return (
                    <li key={f.id} className="catalog-item">
                      <div className="catalog-row">
                        <Mark id={copy.mark} size={52} />
                        <div className="catalog-text">
                          <div className="catalog-name">{copy.name}</div>
                          <div className="catalog-blurb">{copy.blurb}</div>
                        </div>
                        <button
                          data-testid={`flow-${f.id}`}
                          className="pill-btn soft"
                          disabled={!n.available || starting !== null}
                          onClick={() => void startFlow(n, f.id, copy.name)}
                        >
                          {starting === f.id ? "Opening…" : "Connect"}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
        {networks === null && !error && <p className="muted pad">Loading…</p>}

        <section className="catalog-section">
          <div className="section-head">
            <h2 className="display">Connected</h2>
          </div>
          {visibleConnections.length === 0 ? (
            <p className="muted">Nothing yet. Connect something above and it shows up here.</p>
          ) : (
            <ul className="connections">
              {visibleConnections.map((c) => {
                const n = networks?.find((x) => x.id === c.network);
                return (
                  <li key={c.id} data-testid="connection-row" data-network={c.network} data-state={c.state} className="connection">
                    <Mark id={c.network === "demo" ? "demo" : n?.kind === "agent" ? "agents" : "matrix"} size={36} />
                    <div className="connection-text">
                      <strong>{c.remote_name || c.id}</strong>
                      <span className={`conn-state state-${c.state}`}>
                        <span className="state-dot" />
                        {STATE_TEXT[c.state] ?? c.state}
                        {c.state_message ? `: ${c.state_message}` : ""}
                      </span>
                    </div>
                    <button data-testid="connection-remove" className="pill-btn quiet" onClick={() => void remove(c)}>
                      Remove
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      {login && (
        <div
          className="modal-backdrop"
          onClick={(e) => e.target === e.currentTarget && login.step.type !== "complete" && setLogin(null)}
        >
          <div className="modal sheet" role="dialog" aria-modal="true" aria-labelledby="login-title">
            <div className="sheet-head">
              <Mark id={flowCopy(login.flowId, login.flowName, "", login.network).mark} size={40} />
              <h2 id="login-title" className="display">
                {login.flowName}
              </h2>
              <button className="icon-btn" aria-label="Close" onClick={() => setLogin(null)}>
                <Icon name="close" />
              </button>
            </div>
            <LoginStepView
              key={login.step.step_id + login.step.type}
              processId={login.processId}
              step={login.step}
              onStep={(step) => {
                setLogin((l) => (l ? { ...l, step } : l));
                if (step.type === "complete") onComplete();
              }}
              onDone={() => setLogin(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
