// Types shared by the desktop connectors (C: agents reached through the user's
// own signed-in web session, running on this Mac).

import type { AgentEvent, AgentInfo, InboundMessage } from "./protocol";

export type ServiceId = "grokbot" | "muse" | "dots" | "cue";

export const SERVICES: { id: ServiceId; name: string; description: string }[] = [
  { id: "grokbot", name: "Grok Bot", description: "Your Grok Bot (SpaceX AI). Sign in with your Cursor account in the browser." },
  { id: "muse", name: "Muse", description: "Meta's Muse agent. Sign in to muse.ai in an AgentStudio window." },
  { id: "dots", name: "ChatGPT Dots", description: "OpenAI's Dots agent in ChatGPT. Sign in to chatgpt.com in an AgentStudio window." },
  { id: "cue", name: "Cue", description: "Your Cue agents (by Manus), through a Manus API key." },
];

/** Where a connector sends what the agent says. */
export interface Emitter {
  emit(evt: AgentEvent): void;
  /** The connector's avatar (or name) changed; the host tells the bridge. */
  profileChanged(): void;
}

export type AvatarImage = { mime: string; data: Buffer };

export type ConnectorState = { status: "ready" | "needs_login" | "starting" | "reconnecting" | "error"; message?: string };

export interface Connector {
  info(): AgentInfo;
  /** Starts background work (polling, the service window). Called once, after login or on app start. */
  start(emitter: Emitter): Promise<void>;
  stop(): Promise<void>;
  /** Handles one message from the user. Results go out through the emitter. */
  send(msg: InboundMessage): Promise<void>;
  /** The user's answer to an approval this connector requested. */
  decide(externalId: string, choice: string): Promise<void>;
  state(): ConnectorState;
  /** Shows the service's own UI, for steps the user must do there. */
  open?(): void;
  /** The agent's face: its live avatar from the service, or the service's icon. */
  avatar?(): Promise<AvatarImage | null>;
  /** Secrets and settings to persist (encrypted) for the next launch. */
  serialize(): unknown;
}

export class UnknownApprovalError extends Error {
  constructor() {
    super("unknown approval");
  }
}

/** Progress of a connect flow, polled by the renderer. */
export type LoginProgress =
  /** actions: buttons the user can press meanwhile; answer with choose(loginId, id). */
  | { state: "waiting"; message: string; actions?: { id: string; label: string }[] }
  | { state: "choose"; message: string; choices: { id: string; label: string }[] }
  /** The user has to type something (a Cue API key); answer with submit(loginId, value). */
  | { state: "input"; message: string; label: string; secret: boolean; link?: { label: string; url: string }; error?: string }
  | { state: "ready"; instances: { instanceId: string; name: string; url: string; token: string }[] }
  | { state: "failed"; message: string }
  | { state: "cancelled" };

export type ConnectorSummary = {
  id: string;
  service: ServiceId;
  name: string;
  status: ConnectorState["status"];
  message?: string;
  url: string;
  canOpen: boolean;
  connectionId?: string;
};

/** Optional trace sink for calibrating connectors against live services (AGENTSTUDIO_CONNECTOR_TRACE=1). */
export type Trace = (kind: string, data: unknown) => void;
