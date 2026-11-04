// Owns the connectors on this Mac: the local protocol host, the encrypted
// instance store, sign-in flows and the IPC the renderer uses. The renderer
// finishes a connect by registering the instance with the agents bridge
// (endpoint flow: url + token), so the agent shows up like any other.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { BrowserWindow, shell } from "electron";
import { ConnectorHost, newToken } from "./host";
import { ConnectorStore, type InstanceRecord } from "./store";
import { GROK_DEFAULTS, GrokBotConnector, GrokClient, grokLogin, type GrokConfig, type GrokData, type GrokLoginResult } from "./grokbot";
import { WebChatConnector, snapshotOf, type WebChatConfig, type WebChatData } from "./webchat";
import { DOTS_DRIVER, MUSE_DRIVER } from "./drivers";
import { grokAvatar } from "./grokavatar";
import { cueWebSignIn, createCueApiKey, handleCueLink, type CueWebConfig } from "./cueweb";
import { CUE_DEFAULTS, CueAuthError, CueClient, CueConnector, cueAccountKey, type CueConfig, type CueData } from "./cue";
import { SERVICES, type AvatarImage, type Connector, type ConnectorSummary, type LoginProgress, type ServiceId, type Trace } from "./types";
// Official images (packages/brand), used until the service shows the agent's own avatar.
import chatgptIcon from "@agentstudio/brand/assets/chatgpt.png?asset";
import cueIcon from "@agentstudio/brand/assets/cue.png?asset";
import grokbotIcon from "@agentstudio/brand/assets/grokbot.png?asset";
import museMascot from "@agentstudio/brand/assets/muse.jpg?asset";

function bundledImage(path: string, mime: string): () => Promise<AvatarImage | null> {
  let cached: AvatarImage | null = null;
  return async () => {
    try {
      cached ??= { mime, data: readFileSync(path) };
      return cached;
    } catch {
      return null;
    }
  };
}
const FALLBACK = {
  grokbot: bundledImage(grokbotIcon, "image/png"),
  muse: bundledImage(museMascot, "image/jpeg"),
  dots: bundledImage(chatgptIcon, "image/png"),
  cue: bundledImage(cueIcon, "image/png"),
};

type Running = { record: InstanceRecord; connector: Connector };

/**
 * Bots saved before agent_id was read could share one id, and then all took
 * that bot's name. Give them back the name they were connected with and drop
 * the shared id, so the connector finds each one again by name
 * (GrokBotConnector.refreshProfile).
 */
function repairGrokNames(records: InstanceRecord[]) {
  const grok = records.filter((r) => r.service === "grokbot");
  const count = new Map<string, number>();
  for (const r of grok) {
    const id = (r.data as GrokData).agent.id;
    count.set(id, (count.get(id) ?? 0) + 1);
  }
  for (const r of grok) {
    const agent = (r.data as GrokData).agent;
    if ((count.get(agent.id) ?? 0) > 1 && r.name) {
      agent.name = r.name;
      agent.id = ""; // found again by name
    }
  }
}

type Login = {
  service: ServiceId;
  progress: LoginProgress;
  abort: AbortController;
  /** Resolves the "choose" step (Grok Bot accounts with several bots). */
  choose?: (choiceId: string) => void;
  /** Resolves an "input" step (the Cue API key). */
  submit?: (value: string) => void;
};

export type ConnectorsEnv = {
  port: number;
  grok: Omit<GrokConfig, "trace">;
  cue: Omit<CueConfig, "trace"> & CueWebConfig & { settingsUrl: string };
  museUrl: string;
  dotsUrl: string;
  show: boolean;
  /** Open sign-in pages in an AgentStudio window instead of the browser (tests). */
  openExternalInWindow: boolean;
};

export function connectorsEnvFromProcess(env = process.env): ConnectorsEnv {
  return {
    port: Number(env.AGENTSTUDIO_CONNECTOR_PORT || 18401),
    grok: {
      apiUrl: (env.AGENTSTUDIO_GROKBOT_API_URL || GROK_DEFAULTS.apiUrl).replace(/\/+$/, ""),
      webUrl: (env.AGENTSTUDIO_GROKBOT_WEB_URL || GROK_DEFAULTS.webUrl).replace(/\/+$/, ""),
      clientId: GROK_DEFAULTS.clientId,
      clientVersion: GROK_DEFAULTS.clientVersion,
      pollActiveMs: Number(env.AGENTSTUDIO_GROKBOT_POLL_MS || 2000),
      pollIdleMs: 15_000,
    },
    cue: {
      apiUrl: (env.AGENTSTUDIO_CUE_API_URL || CUE_DEFAULTS.apiUrl).replace(/\/+$/, ""),
      settingsUrl: env.AGENTSTUDIO_CUE_SETTINGS_URL || CUE_DEFAULTS.settingsUrl,
      webUrl: (env.AGENTSTUDIO_CUE_WEB_URL || CUE_DEFAULTS.webUrl).replace(/\/+$/, ""),
      rpcUrl: (env.AGENTSTUDIO_CUE_RPC_URL || CUE_DEFAULTS.rpcUrl).replace(/\/+$/, ""),
      pollActiveMs: Number(env.AGENTSTUDIO_CUE_POLL_MS || 3000),
      pollIdleMs: 20_000,
      listBudgetPerMinute: 80,
    },
    museUrl: env.AGENTSTUDIO_MUSE_URL || "https://muse.ai/",
    dotsUrl: env.AGENTSTUDIO_DOTS_URL || "https://chatgpt.com/dots/home",
    show: env.AGENTSTUDIO_CONNECTOR_SHOW === "1",
    openExternalInWindow: env.AGENTSTUDIO_CONNECTOR_OPEN_IN_WINDOW === "1",
  };
}

export class ConnectorManager {
  private readonly host: ConnectorHost;
  private readonly store: ConnectorStore;
  private readonly running = new Map<string, Running>();
  private readonly logins = new Map<string, Login>();
  /** Stored records that aren't running (yet, or because they failed to start). */
  private readonly dormant = new Map<string, InstanceRecord>();
  private readonly trace: Trace | undefined;
  private readonly networkTraceFile: string | undefined;
  /** One client per Grok Bot account (keyed by machine id), shared by all its bots. */
  private readonly grokClients = new Map<string, GrokClient>();
  /** One client per Manus API key, shared by all its Cue agents (they share a rate limit). */
  private readonly cueClients = new Map<string, CueClient>();

  constructor(
    private readonly env: ConnectorsEnv,
    private readonly userData: string,
  ) {
    this.host = new ConnectorHost(
      env.port,
      (msg, extra) => console.log(`[connectors] ${msg}`, extra ?? ""),
      (id, session) => {
        const r = this.running.get(id);
        if (!r) return;
        r.record.bridgeSession = session;
        this.persist();
      },
    );
    this.store = new ConnectorStore(userData);
    if (process.env.AGENTSTUDIO_CONNECTOR_TRACE_NETWORK === "1") {
      const dir = join(userData, "connector-traces");
      mkdirSync(dir, { recursive: true });
      this.networkTraceFile = join(dir, `network-${new Date().toISOString().slice(0, 10)}.jsonl`);
    }
    if (process.env.AGENTSTUDIO_CONNECTOR_TRACE === "1") {
      const dir = join(userData, "connector-traces");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
      this.trace = (kind, data) => {
        try {
          appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), kind, data }) + "\n", { mode: 0o600 });
        } catch {
          /* tracing is best effort */
        }
      };
    }
  }

  async start() {
    await this.host.listen();
    const records = this.store.load();
    repairGrokNames(records);
    // Until a record is running, it is kept as stored: saving while others start
    // (or after one fails to start) must not drop it.
    for (const record of records) this.dormant.set(record.id, record);
    for (const record of records) {
      try {
        await this.run(record);
        this.dormant.delete(record.id);
      } catch (err) {
        console.warn(`[connectors] couldn't start ${record.service} ${record.id}:`, err);
      }
    }
  }

  async stop() {
    for (const r of this.running.values()) await r.connector.stop().catch(() => {});
    this.running.clear();
    await this.host.close();
  }

  services() {
    return SERVICES;
  }

  list(): ConnectorSummary[] {
    return [...this.running.values()].map(({ record, connector }) => ({
      id: record.id,
      service: record.service,
      name: record.name,
      status: connector.state().status,
      message: connector.state().message,
      url: this.host.urlFor(record.id),
      canOpen: typeof connector.open === "function",
      connectionId: record.connectionId,
    }));
  }

  /** Remembers which agents-bridge connection this instance became. */
  attach(id: string, connectionId: string) {
    const r = this.running.get(id);
    if (!r) return;
    r.record.connectionId = connectionId;
    this.persist();
  }

  open(id: string) {
    this.running.get(id)?.connector.open?.();
  }

  async remove(id: string) {
    if (this.dormant.delete(id)) this.persist();
    const r = this.running.get(id);
    if (!r) return;
    this.running.delete(id);
    this.host.remove(id);
    await r.connector.stop().catch(() => {});
    this.persist();
  }

  /** Starts a connect flow; poll progress(loginId) for its state. */
  begin(service: ServiceId): string {
    const loginId = randomBytes(8).toString("hex");
    const login: Login = { service, progress: { state: "waiting", message: "Starting…" }, abort: new AbortController() };
    this.logins.set(loginId, login);
    void this.runLogin(login).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      login.progress = login.abort.signal.aborted ? { state: "cancelled" } : { state: "failed", message: msg };
    });
    return loginId;
  }

  progress(loginId: string): LoginProgress {
    return this.logins.get(loginId)?.progress ?? { state: "failed", message: "Unknown connect flow" };
  }

  choose(loginId: string, choiceId: string) {
    this.logins.get(loginId)?.choose?.(choiceId);
  }

  /** A link the OS opened AgentStudio with (open-url). True when a connector took it. */
  handleLink(url: string): boolean {
    return handleCueLink(url);
  }

  submit(loginId: string, value: string) {
    this.logins.get(loginId)?.submit?.(value);
  }

  cancel(loginId: string) {
    const l = this.logins.get(loginId);
    if (!l) return;
    l.abort.abort();
    l.progress = { state: "cancelled" };
  }

  // ---- internals -------------------------------------------------------------------

  private openExternal = async (url: string) => {
    if (this.env.openExternalInWindow) {
      const w = new BrowserWindow({ width: 900, height: 760, title: "Sign in", webPreferences: { sandbox: true, contextIsolation: true } });
      // A browser would hand app links (cuedev://) to the OS; do that here.
      const appLink = (e: { preventDefault(): void }, target: string) => {
        if (!handleCueLink(target)) return;
        e.preventDefault();
        if (!w.isDestroyed()) w.close();
      };
      w.webContents.on("will-navigate", appLink);
      w.webContents.on("will-redirect", appLink);
      await w.loadURL(url).catch(() => {});
      return;
    }
    await shell.openExternal(url);
  };

  private webConfig(service: "muse" | "dots"): WebChatConfig {
    return service === "muse"
      ? {
          name: "Muse",
          description: "Meta's Muse, through your own muse.ai session on this Mac.",
          partition: "persist:agentstudio-muse",
          url: this.env.museUrl,
          driver: MUSE_DRIVER,
          pollMs: 800,
          show: this.env.show,
          trace: this.trace,
          openLabel: "Open Muse",
          fallbackAvatar: FALLBACK.muse,
          networkTrace: this.networkTraceFile,
        }
      : {
          name: "Dots",
          description: "ChatGPT Dots, through your own ChatGPT session on this Mac.",
          partition: "persist:agentstudio-dots",
          url: this.env.dotsUrl,
          driver: DOTS_DRIVER,
          pollMs: 800,
          show: this.env.show,
          trace: this.trace,
          openLabel: "Open ChatGPT",
          fallbackAvatar: FALLBACK.dots,
          networkTrace: this.networkTraceFile,
        };
  }

  private create(record: InstanceRecord): Connector {
    switch (record.service) {
      case "grokbot": {
        const data = record.data as GrokData;
        return new GrokBotConnector(
          { ...this.env.grok, trace: this.trace },
          data,
          this.grokClient(data),
          () => this.persist(),
          // The bot's own avatar (drawn with the installed Grok Bot app's shapes), else the Grok Bot icon.
          async (agent) => (await grokAvatar(agent, this.userData)) ?? (await FALLBACK.grokbot()),
        );
      }
      case "muse":
      case "dots":
        return new WebChatConnector(this.webConfig(record.service), record.data as WebChatData);
      case "cue": {
        const data = record.data as CueData;
        return new CueConnector({ ...this.env.cue, trace: this.trace }, data, this.cueClient(data.apiKey), () => this.persist(), FALLBACK.cue);
      }
    }
  }

  private grokClient(data: GrokData): GrokClient {
    let c = this.grokClients.get(data.machineId);
    if (!c) {
      // A refresh rotates the tokens for every bot of the account: persist them all.
      c = new GrokClient({ ...this.env.grok, trace: this.trace }, data, data.machineId, () => this.persist());
      this.grokClients.set(data.machineId, c);
    }
    return c;
  }

  private cueClient(apiKey: string): CueClient {
    const key = cueAccountKey(apiKey);
    let c = this.cueClients.get(key);
    if (!c) {
      c = new CueClient({ ...this.env.cue, trace: this.trace }, apiKey);
      this.cueClients.set(key, c);
    }
    return c;
  }

  /**
   * Cue: sign in with the Manus account in an AgentStudio window (AgentStudio then
   * creates an API key for itself), or paste an API key.
   */
  private async cueLogin(login: Login) {
    const signal = login.abort.signal;
    let error: string | undefined;
    const web = new AbortController();
    signal.addEventListener("abort", () => web.abort(), { once: true });
    login.progress = {
      state: "waiting",
      message: "Sign in to Manus (your Cue account) in your browser. AgentStudio picks it up when you're done…",
      actions: [{ id: "api-key", label: "Use an API key instead" }],
    };
    const switched = new Promise<"api-key">((resolve) => {
      login.choose = (id) => id === "api-key" && resolve("api-key");
    });
    const signIn = cueWebSignIn(this.env.cue, this.openExternal, web.signal, this.env.openExternalInWindow ? null : join(this.userData, "link-catcher")).then((token) => ({ token }));
    signIn.catch(() => {}); // the user may switch to a key and close the window
    try {
      const r = await Promise.race([signIn, switched]);
      if (r !== "api-key") {
        login.progress = { state: "waiting", message: "Creating an API key for AgentStudio…" };
        const apiKey = await createCueApiKey(this.env.cue, r.token);
        await this.cueConnect(login, apiKey);
        return;
      }
    } catch (err) {
      if (signal.aborted) throw err;
      error = `Signing in didn't work: ${(err as Error).message} You can paste an API key instead.`;
    } finally {
      login.choose = undefined;
      web.abort();
    }
    // Paste a key, until one works.
    for (;;) {
      login.progress = {
        state: "input",
        message: "Create an API key in Manus settings (Developers → Create API Key), then paste it here. It stays on this Mac.",
        label: "Manus API key",
        secret: true,
        link: { label: "Open Manus settings", url: this.env.cue.settingsUrl },
        error,
      };
      const key = await new Promise<string>((resolve, reject) => {
        login.submit = resolve;
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
      login.submit = undefined;
      const apiKey = key.trim();
      if (!apiKey) {
        error = "Paste the key first.";
        continue;
      }
      try {
        await this.cueConnect(login, apiKey);
        return;
      } catch (err) {
        if (signal.aborted) throw err;
        error = err instanceof CueAuthError ? "Manus didn't accept that key. Check it and try again." : (err as Error).message;
      }
    }
  }

  /** Checks a Manus API key and connects every agent of that account. */
  private async cueConnect(login: Login, apiKey: string) {
    login.progress = { state: "waiting", message: "Checking the key…" };
    const client = this.cueClient(apiKey);
    try {
      await client.me();
      const agents = await client.listAgents();
      const have = new Set([...this.running.values()].filter((r) => r.record.service === "cue").map((r) => (r.record.data as CueData).agent.taskId));
      const fresh = agents.filter((a) => !have.has(a.taskId));
      login.progress = { state: "waiting", message: `Connecting ${fresh.length} ${fresh.length === 1 ? "agent" : "agents"}…` };
      await this.finish(login, fresh.map((agent) => ({ record: this.newRecord("cue", agent.name || "Cue", { apiKey, agent } satisfies CueData) })));
    } catch (err) {
      const inUse = [...this.running.values()].some((r) => r.record.service === "cue" && (r.record.data as CueData).apiKey === apiKey);
      if (!inUse) this.cueClients.delete(cueAccountKey(apiKey));
      throw err;
    }
  }

  private async run(record: InstanceRecord, connector = this.create(record)) {
    const emitter = this.host.add({ id: record.id, token: record.token, connector, session: record.bridgeSession });
    this.running.set(record.id, { record, connector });
    await connector.start(emitter);
    // After a restart, the bridge still has the avatar it fetched before; send the current one.
    if (record.bridgeSession) this.host.sendProfile(record.id);
  }

  private persist() {
    this.store.save([
      ...[...this.dormant.values()].filter((r) => !this.running.has(r.id)),
      ...[...this.running.values()].map(({ record, connector }) => ({ ...record, data: connector.serialize() })),
    ]);
  }

  private newRecord(service: ServiceId, name: string, data: unknown): InstanceRecord {
    return {
      id: randomBytes(9).toString("base64url").replace(/[^A-Za-z0-9]/g, "x"),
      service,
      token: newToken(),
      name,
      createdAt: new Date().toISOString(),
      data,
    };
  }

  /** Starts the new instances and hands the renderer what it needs to register them. */
  private async finish(login: Login, items: { record: InstanceRecord; connector?: Connector }[]) {
    for (const { record, connector } of items) await this.run(record, connector);
    this.persist();
    login.progress = {
      state: "ready",
      instances: items.map(({ record }) => ({ instanceId: record.id, name: record.name, url: this.host.urlFor(record.id), token: record.token })),
    };
  }

  private async runLogin(login: Login) {
    const signal = login.abort.signal;
    if (login.service === "grokbot") {
      login.progress = { state: "waiting", message: "Finish signing in to Grok Bot in your browser…" };
      const res: GrokLoginResult = await grokLogin({ ...this.env.grok, trace: this.trace }, this.openExternal, signal);
      // Every bot of the account becomes its own contact; already connected bots are skipped.
      const have = new Set(
        [...this.running.values()].filter((r) => r.record.service === "grokbot").map((r) => (r.record.data as GrokData).agent.id),
      );
      const fresh = res.agents.filter((a) => !have.has(a.id));
      login.progress = { state: "waiting", message: `Connecting ${fresh.length} ${fresh.length === 1 ? "bot" : "bots"}…` };
      await this.finish(
        login,
        fresh.map((agent) => ({ record: this.newRecord("grokbot", agent.name || "Grok Bot", { ...res.tokens, machineId: res.machineId, agent } satisfies GrokData) })),
      );
      return;
    }
    if (login.service === "cue") return this.cueLogin(login);
    const service = login.service;
    const cfg = this.webConfig(service);
    const connector = new WebChatConnector(cfg, { connectedAt: new Date().toISOString() });
    login.progress = {
      state: "waiting",
      message: `Sign in to ${cfg.name} in the AgentStudio window that opened. ${cfg.name} keeps your sign-in in the browser's cookies, which AgentStudio can't read, so it signs in here. If Google refuses to sign in inside an app, use another way to sign in there.`,
    };
    try {
      await connector.session.signIn(async (wc) => (await snapshotOf(connector.session, cfg.driver, wc)).signedIn, signal);
    } catch (err) {
      connector.session.close();
      throw err;
    }
    await this.finish(login, [{ record: this.newRecord(service, cfg.name, { connectedAt: new Date().toISOString() }), connector }]);
  }
}
