# AgentStudio REST API (v1)

Base URL: `AGENTSTUDIO_SERVER_URL`, for example `http://127.0.0.1:18090`. All bodies are JSON. Timestamps are RFC 3339 UTC strings. IDs are opaque strings.

## Conventions

- Auth header: `Authorization: Bearer <access_token>`. Every `/v1/*` route requires it except `/v1/auth/*`, `/v1/networks`, `/v1/health` and `/v1/dev/*`.
- Errors use one shape: `{"error": {"code": "snake_case", "message": "Human text"}}`. Codes and statuses:

  | Status | Code |
  |---|---|
  | 400 | `bad_request` |
  | 401 | `unauthenticated` |
  | 403 | `forbidden` |
  | 404 | `not_found` |
  | 409 | `version_conflict` |
  | 410 | `expired` |
  | 422 | `invalid_code` |
  | 429 | `rate_limited` |
  | 502 | `upstream_error` |

- Optimistic concurrency: mutating approvals and tasks requires the current `version`. A stale version returns 409 with the current object in `error.current`.
- Idempotency: a repeated `idempotency_key` for the same user and route returns the original result.
- CORS: the API allows the origins in `AGENTSTUDIO_ALLOWED_ORIGINS` (comma list). Dev mode also allows `http://127.0.0.1:*`, `http://localhost:*` and `null`. The desktop renderer may run from `file://`.
- `/_matrix/*` is reverse-proxied to Synapse unchanged. Clients pass `matrix.homeserver_url` (= base URL) to matrix-js-sdk.

## Health and dev

- `GET /v1/health` returns `{"ok": true, "synapse": true, "bridges": {"demo": true, "agentstudio-agents": true}}`.
- `GET /v1/dev/outbox?email=<email>` returns `{"messages": [{"to", "subject", "code", "sent_at"}]}`, newest first. It exists only when `AGENTSTUDIO_DEV=1`. E2e reads sign-in codes from it.

## Auth

The flow is email code sign-in. Codes are 6 digits, valid for 10 minutes, and stored hashed. A new code is allowed after 30 seconds.

- `POST /v1/auth/email/start {email}` returns 204. In dev mode the mail goes to the dev outbox and to the log.
- `POST /v1/auth/email/verify {email, code, device_name}` returns a `Session`. On a user's first sign-in the API creates the user and its Matrix account.
- `POST /v1/auth/local {device_name}` returns a `Session` for the person on this Mac, without an email code. Only in local mode (`AGENTSTUDIO_LOCAL=1`, which `GET /v1/health` reports as `local: true`), and only for requests from the same machine that no proxy forwarded. The account is always `you@agentstudio.local`.
- `POST /v1/auth/refresh {refresh_token}` returns a `Session`. The refresh token rotates; reusing an old one revokes the session.
- `POST /v1/auth/logout` returns 204. It revokes the session and logs out the Matrix device.
- `GET /v1/me` returns `{"user": User}`.

```ts
type User = { id: string; email: string; matrix_user_id: string; created_at: string }
type Session = {
  session_id: string
  access_token: string          // short-lived, 15 min
  access_expires_at: string
  refresh_token: string         // 60 days; clients keep it in secure storage
  user: User
  matrix: { homeserver_url: string; user_id: string; device_id: string; access_token: string }
}
```

The Matrix account is `@u_<user id>:agentstudio.local`. The API logs in to Synapse with `org.matrix.login.jwt`, signed with `SYNAPSE_JWT_SECRET`, `sub` = localpart. Synapse auto-registers the user and gives each session its own device.

## Networks and connections

Connections are proxied to mautrix bridgev2 provisioning (`/_matrix/provision/v3/...`, shared secret, `user_id` = the caller's Matrix ID). The API adds a `connection_id` and stores connections.

- `GET /v1/networks` returns `{"networks": [Network]}`.
- `GET /v1/connections` returns `{"connections": [Connection]}`.
- `POST /v1/connections/{network}/logins {flow_id}` returns `{"process_id", "step": LoginStep}`.
- `POST /v1/connections/logins/{process_id}/steps/{step_id} {"fields"?: {id: value}, "cookies"?: {id: value}}` returns `{"step": LoginStep}`.
- `POST /v1/connections/logins/{process_id}/steps/{step_id}/wait` returns `{"step": LoginStep}`. This is a long poll for `display_and_wait`, up to 60 s. On timeout it returns the unchanged step; the client polls again.
- `DELETE /v1/connections/{connection_id}` returns 204. It logs out the bridge login and marks the connection removed. Agents on the connection are paused.

```ts
type Network = {
  id: string                    // "demo" | "agentstudio-agents" | "whatsapp" | ...
  name: string                  // "Demo", "Agents", "WhatsApp"
  kind: "chat" | "agent"
  bot_mxid: string
  available: boolean            // bridge reachable
  flows: { id: string; name: string; description: string }[]
}
type Connection = {
  id: string                    // "<network>:<user_login_id>"
  network: string
  remote_name: string           // e.g. "Demo account", "Concierge"
  state: "connecting" | "connected" | "bad_credentials" | "transient_disconnect" | "logged_out"
  state_message?: string
  created_at: string; updated_at: string
}
type LoginStep = {                // mirrors bridgev2 LoginStep, plus AgentStudio's connection_id
  type: "user_input" | "display_and_wait" | "cookies" | "complete"
  step_id: string
  instructions?: string
  user_input?: { fields: { type: "username" | "phone_number" | "email" | "password" | "2fa_code" | "token" | "url" | "domain" | "select"; id: string; name: string; description?: string; default_value?: string; options?: string[] }[] }
  display_and_wait?: { type: "qr" | "emoji" | "code" | "nothing"; data?: string }
  cookies?: { url: string; user_agent?: string; fields: { id: string; required: boolean }[]; extract_js?: string }
  complete?: { user_login_id: string; connection_id: string }
}
```

## Agents

An agent is a contact backed by the `agentstudio-agents` bridge, one agent per connection. The bridge registers agents through the internal API.

- `GET /v1/agents` returns `{"agents": [Agent]}`.
- `PUT /v1/agents/{agent_id}/consent {ask_without_preview: boolean}` returns `Agent`. The setting is per user; "don't ask again" sets it to true.

```ts
type Agent = {
  id: string                    // "<connection_id>"
  connection_id: string
  name: string; description?: string; avatar_url?: string
  room_id: string | null        // the DM room with the agent ghost
  capabilities: ("chat" | "ask" | "approvals")[]
  status: "idle" | "working" | "offline"; status_text?: string
  pending_approvals: number
  consent: { ask_without_preview: boolean }
}
```

## Approvals

- `GET /v1/approvals?state=pending|all` returns `{"approvals": [Approval]}`, newest first. The default is `pending`.
- `GET /v1/approvals/{id}` returns `Approval`.
- `POST /v1/approvals/{id}/decision {choice, version, idempotency_key}` returns `Approval`. It sets state `decided`, delivery `queued`, then delivers to the bridge synchronously (5 s timeout). Delivery ends as `delivered` or `failed`. A decision after `expires_at` returns 410.

```ts
type Approval = {
  id: string; version: number
  agent_id: string; agent_name: string
  room_id: string | null; event_id: string | null   // the card message in the agent room
  title: string                 // "Book the 6pm flight to Toronto for $412?"
  summary?: string
  details: { label: string; value: string }[]
  choices: { key: string; label: string; category: "approve" | "deny" }[]
  state: "pending" | "decided" | "expired" | "cancelled"
  decision: { choice: string; decided_at: string } | null
  delivery_state: "queued" | "delivered" | "failed" | null
  expires_at: string | null
  created_at: string; updated_at: string
}
```

## Tasks ("Ask an agent")

The client creates the task, then sends the ask message into the agent's room. The message has content key `com.agentstudio.ask` with `task_id`; see `docs/matrix-events.md`. The bridge forwards the ask to the agent. Draft replies come back as a `com.agentstudio.drafts` message, and the bridge marks the task `answered`.

- `POST /v1/tasks {agent_id, idempotency_key, request_text, origin, title?}` returns `Task` with state `pending`. `title` is the anchor message text (the API keeps its first line, 80 chars max); without it the title comes from `request_text`.
- `GET /v1/tasks?state=open|all` returns `{"tasks": [Task]}`. `open` means `pending` + `answered`.
- `POST /v1/tasks/{id}/sent {version, draft_index}` returns `Task` with state `done`. The user sent a draft back to the origin chat.
- `POST /v1/tasks/{id}/cancel {version}` returns `Task` with state `cancelled`.

```ts
type Task = {
  id: string; version: number
  agent_id: string; agent_name: string
  state: "pending" | "answered" | "done" | "cancelled" | "failed"
  title: string                 // first line of the anchor message, 80 chars max
  request_text: string
  origin: { room_id: string; network: string; chat_name: string; anchor_event_id: string }
  answer: { event_id: string; drafts: { text: string }[] } | null
  sent_draft_index: number | null
  created_at: string; updated_at: string
}
```

## Internal API (bridges only)

Internal routes authenticate with `Authorization: Bearer <AGENTSTUDIO_INTERNAL_SECRET>` and are never exposed through CORS.

- `POST /internal/v1/bridge-state` receives bridgev2 `status_endpoint` posts (BridgeState JSON, which includes `user_id`, `remote_id`, `remote_name`, `state_event`). The API upserts the connection state. Exception to the internal secret: bridgev2 authenticates this call with its appservice `as_token`, so the API accepts any configured bridge `as_token` here.
- `PUT /internal/v1/agents {owner_mxid, connection_id, name, description?, avatar_url?, capabilities, room_id?}` upserts an agent and returns `Agent`.
- `PATCH /internal/v1/agents/{agent_id} {status?, status_text?, room_id?}` returns `Agent`.
- `POST /internal/v1/approvals {owner_mxid, agent_id, external_id, title, summary?, details, choices, expires_at?, room_id?, event_id?}` returns `Approval`. It is idempotent on (agent_id, external_id).
- `PATCH /internal/v1/approvals/{id} {room_id?, event_id?, state?: "cancelled"}` returns `Approval`.
- `POST /internal/v1/tasks/{id}/answer {event_id, drafts}` returns `Task` with state `answered`.
- `POST /internal/v1/tasks/{id}/fail {reason}` returns `Task` with state `failed`.

The API calls the agents bridge with the same internal secret:

- `POST {AGENTS_BRIDGE_URL}/agentstudio/internal/v1/approval-decisions {approval_id, agent_id, external_id, choice}` returns 200 when delivered to the agent.

## Security notes (v0.1)

- Access tokens are HMAC-SHA256 JWTs (`AGENTSTUDIO_TOKEN_SECRET`). Refresh tokens and email codes are stored only as SHA-256 hashes.
- Matrix tokens are minted per session. Logging out deletes the Matrix device.
- Agent tokens and bridge credentials live in the bridge databases. Message bodies and tokens are never logged.
