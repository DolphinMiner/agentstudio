// REST API types, exactly as documented in docs/api.md.

export type User = { id: string; email: string; matrix_user_id: string; created_at: string };

export type MatrixCredentials = {
  homeserver_url: string;
  user_id: string;
  device_id: string;
  access_token: string;
};

export type Session = {
  session_id: string;
  access_token: string; // short-lived, 15 min
  access_expires_at: string;
  refresh_token: string; // 60 days; clients keep it in secure storage
  user: User;
  matrix: MatrixCredentials;
};

export type Health = {
  ok: boolean;
  synapse: boolean;
  bridges: Record<string, boolean>;
  /** Local mode: the server runs on this Mac for one person, who signs in without email (signInLocal). */
  local?: boolean;
};

export type DevOutboxMessage = { to: string; subject: string; code: string; sent_at: string };

export type LoginFlow = { id: string; name: string; description: string };

export type Network = {
  id: string; // "demo" | "agentstudio-agents" | "whatsapp" | ...
  name: string; // "Demo", "Agents", "WhatsApp"
  kind: "chat" | "agent";
  bot_mxid: string;
  available: boolean; // bridge reachable
  flows: LoginFlow[];
};

export type ConnectionState =
  | "connecting"
  | "connected"
  | "bad_credentials"
  | "transient_disconnect"
  | "logged_out";

export type Connection = {
  id: string; // "<network>:<user_login_id>"
  network: string;
  remote_name: string;
  state: ConnectionState;
  state_message?: string;
  created_at: string;
  updated_at: string;
};

export type LoginFieldType =
  | "username"
  | "phone_number"
  | "email"
  | "password"
  | "2fa_code"
  | "token"
  | "url"
  | "domain"
  | "select";

export type LoginField = {
  type: LoginFieldType;
  id: string;
  name: string;
  description?: string;
  default_value?: string;
  options?: string[];
};

export type LoginStep = {
  type: "user_input" | "display_and_wait" | "cookies" | "complete";
  step_id: string;
  instructions?: string;
  user_input?: { fields: LoginField[] };
  display_and_wait?: { type: "qr" | "emoji" | "code" | "nothing"; data?: string };
  cookies?: {
    url: string;
    user_agent?: string;
    fields: { id: string; required: boolean }[];
    extract_js?: string;
  };
  complete?: { user_login_id: string; connection_id: string };
};

export type LoginStepInput = {
  fields?: Record<string, string>;
  cookies?: Record<string, string>;
};

export type AgentCapability = "chat" | "ask" | "approvals";
export type AgentStatus = "idle" | "working" | "offline";

export type Agent = {
  id: string; // "<connection_id>"
  connection_id: string;
  name: string;
  description?: string;
  avatar_url?: string;
  room_id: string | null; // the DM room with the agent ghost
  capabilities: AgentCapability[];
  status: AgentStatus;
  status_text?: string;
  pending_approvals: number;
  consent: { ask_without_preview: boolean };
};

export type ApprovalChoice = { key: string; label: string; category: "approve" | "deny" };
export type ApprovalState = "pending" | "decided" | "expired" | "cancelled";

export type Approval = {
  id: string;
  version: number;
  agent_id: string;
  agent_name: string;
  room_id: string | null;
  event_id: string | null; // the card message in the agent room
  title: string;
  summary?: string;
  details: { label: string; value: string }[];
  choices: ApprovalChoice[];
  state: ApprovalState;
  decision: { choice: string; decided_at: string } | null;
  delivery_state: "queued" | "delivered" | "failed" | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TaskState = "pending" | "answered" | "done" | "cancelled" | "failed";

export type TaskOrigin = {
  room_id: string;
  network: string;
  chat_name: string;
  anchor_event_id: string;
};

export type Task = {
  id: string;
  version: number;
  agent_id: string;
  agent_name: string;
  state: TaskState;
  title: string; // first line of the anchor message, 80 chars max
  request_text: string;
  origin: TaskOrigin;
  answer: { event_id: string; drafts: { text: string }[] } | null;
  sent_draft_index: number | null;
  created_at: string;
  updated_at: string;
};

export type ApiErrorCode =
  | "bad_request"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "version_conflict"
  | "expired"
  | "invalid_code"
  | "rate_limited"
  | "upstream_error"
  // client-side codes (status 0)
  | "network_error"
  | "timeout"
  | "aborted"
  | "bad_response"
  | (string & {});

export type ApiErrorBody = {
  error: { code: ApiErrorCode; message: string; current?: unknown };
};
