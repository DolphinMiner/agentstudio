# AgentStudio Agent Protocol (v0)

This protocol lets any AI agent become a contact in AgentStudio. It is plain HTTP + JSON with bearer tokens in both directions.

There are two sides:

- The **agent**, the server you write.
- The **bridge**, `agentstudio-bridge-agents`, which runs inside an AgentStudio deployment.

Each AgentStudio connection to an agent is a **session**: one user talking to one agent in one conversation.

## Connecting

A user adds an agent in AgentStudio under *Connect, Agents*. The flows are:

- `endpoint`: the user enters the agent's base URL and an optional access token.
- `concierge`: the built-in reference agent, from `AGENTSTUDIO_CONCIERGE_URL`. There are no fields.

The bridge then runs these calls:

1. `GET {base}/agentstudio/v0/info` returns `AgentInfo`.
2. `POST {base}/agentstudio/v0/sessions` with body `{ "callback_url", "callback_token", "user": { "display_name" }, "session_id"? }` returns `{ "session_id" }`.
   - `callback_url` is the bridge's per-session URL, `{bridge}/agentstudio/v0/callback/{session_key}`.
   - `callback_token` is a random 32-byte token. The agent must send it back on every callback. The bridge stores only its hash.
   - `session_id` is set when the bridge re-registers a session it already has. The agent should resume it and return the same id, but may return a new one.
3. The bridge creates the DM room with the agent ghost and registers the agent with the API.

The bridge re-registers every session (step 2, with `session_id` and a fresh `callback_token`) when it starts, and again whenever the agent answers a call with 404. Agents that keep sessions in memory therefore survive restarts of either side; the old callback token stops working once a new one is issued.

Bridge-side ids (stable, so connecting the same agent again reuses the room and the session):

- `user_login_id` = `agent-` + the first 12 hex chars of `sha256(owner mxid + "\n" + base URL)`.
- Agent ghost: `@agents_<user_login_id>:agentstudio.local`. Agent id / connection id in the API: `agentstudio-agents:<user_login_id>`.

If the user entered an access token, the bridge sends it on every call to the agent as `Authorization: Bearer <token>`.

```ts
type AgentInfo = {
  name: string                  // shown as the contact name
  description?: string
  avatar_url?: string           // https URL; the bridge re-uploads it to Matrix
  capabilities: ("chat" | "ask" | "approvals")[]
  protocol: "agentstudio-agent/0"
}
```

## Bridge → agent

Every call carries `X-AgentStudio-Session: <session_id>`. The agent should reply quickly and do slow work asynchronously, sending results through callbacks.

| Call | When | Reply |
|---|---|---|
| `POST {base}/agentstudio/v0/messages` | The user sends a message or an ask | `202 {}` |
| `POST {base}/agentstudio/v0/approvals/{external_id}/decision` | The user decides on an approval | `200 {}` |
| `DELETE {base}/agentstudio/v0/sessions/{session_id}` | The user removes the agent | `204` |

`/messages` body:

```ts
type InboundMessage = {
  session_id: string
  message_id: string            // Matrix event id
  text: string
  sent_at: string
  ask?: {                       // present for "Ask an agent"
    task_id: string
    app: string                 // origin network name, e.g. "Demo"
    chat: string                // origin chat name, already anonymized
    request: string             // what the user asked for, e.g. "Draft a reply"
    lines: { speaker: string; own: boolean; ts: number; text: string }[]
  }
}
```

The decision body is `{ "approval_id": string, "choice": string }`, where `choice` is one of the keys the agent offered.

## Agent → bridge (callbacks)

The agent sends `POST {callback_url}/events` with `Authorization: Bearer <callback_token>` and one event per call. The bridge handles the event before it replies, so an agent that waits for each reply gets its events shown in order. The bridge replies:

- `200 { "ok": true }` when the event was handled.
- `400` for an invalid event (see the limits below), `401` on a bad token and `404` on an unknown session.
- `502` when the bridge could not deliver the event (Matrix or the API failed). The agent may retry; `approval_request` is idempotent on `external_id`.

Limits: text fields at most 20000 characters, ids and choice keys at most 200 bytes, at most 20 `details`, request bodies at most 256 KiB.

```ts
type AgentEvent =
  | { type: "message"; text: string /* may be empty when there are attachments */; reply_to?: string /* message_id */
      attachments?: { url: string /* http(s) */; name?: string; mime_type?: string }[] /* 0..10 */
      from_user?: boolean; via?: string /* the user said this in the service's own app, e.g. "Grok Bot" */
      history?: boolean; ts?: string /* RFC 3339: earlier conversation imported on connect */ }
  | { type: "drafts"; task_id: string; drafts: { text: string }[] /* 1..5 */; text?: string /* optional lead-in */ }
  | { type: "approval_request"; external_id: string; title: string; summary?: string
      details?: { label: string; value: string }[]
      choices: { key: string; label: string; category: "approve" | "deny" }[] /* 2..4, at least one approve and one deny */
      expires_in_seconds?: number }
  | { type: "approval_cancel"; external_id: string }
  | { type: "status"; state: "idle" | "working"; text?: string }
  | { type: "profile"; name?: string; avatar_url?: string }
```

What the bridge does with each event:

- `message`: posts an `m.text` from the agent ghost, then each attachment: the bridge downloads it (up to 25 MiB) and posts an `m.image` (for `image/*`) or `m.file`; one it can't fetch becomes a link. `from_user`/`via` and `history` become content keys clients read (see [matrix-events.md](matrix-events.md)); with `ts`, the message keeps its original time.
- `drafts`: posts an `m.notice` with content key `com.agentstudio.drafts` and marks the task answered.
- `approval_request`: creates the approval through the API, then posts an `m.text` with content key `com.agentstudio.approval`.
- `approval_cancel`: cancels the approval.
- `status`: updates the agent's status in the API.
- `profile`: updates the agent's name and/or avatar after the session started. The bridge downloads `avatar_url` and sets it as the ghost's Matrix avatar, so clients show it. Change the URL (for example with a version query) when the image changes.

## Reference agent: `concierge`

`server/cmd/agentstudio-agent-concierge` is deterministic so that tests can rely on it.

- `info` returns name "Concierge", capabilities `["chat", "ask", "approvals"]`.
- A message containing "flight" (case-insensitive) produces:
  1. `status working` with text "Searching flights".
  2. `message` "Found a nonstop to Toronto on Friday at 6:00 PM for $412."
  3. `approval_request`:
     - `external_id` = `flight-<message_id hash>`
     - title "Book the 6pm flight to Toronto for $412?"
     - details: Date "Friday", Route "Nonstop", Seat "14A, carry-on only"
     - choices: `book` "Book" (approve), `skip` "Don't book" (deny)
     - expires in 2700 s
  4. `status idle`.
- Decision `book` sends `message` "Booked. Seat 14A, confirmation PCH412." Decision `skip` sends `message` "Okay, I won't book it." A repeated decision for the same `external_id` is acknowledged without a second message.
- A message with `ask` produces a `drafts` event with three drafts for `task_id`:
  - "Sounds good, see you then!"
  - "Thanks! Let me check and get back to you."
  - "Got it 👍"
  These are prefixed with the speaker's first name when the last line is not own, e.g. "Leo, sounds good, see you then!". A speaker named `Person N` is used whole.
- Any other message gets the reply `message` "You said: <text>".

## Agents that speak other protocols

`agentstudio-agent-adapters` (port 18202) serves this protocol in front of agents that speak something else. The agents bridge connects them like any agent endpoint, through two extra login flows:

| Flow | Input | Adapter URL the bridge uses |
|---|---|---|
| `a2a` | the A2A agent's base URL (where `/.well-known/agent-card.json` is served), optional token | `{adapters}/a2a/{base64url(agent URL)}` |
| `acp` | one agent id from `AGENTSTUDIO_ACP_AGENTS` (a `select` field) | `{adapters}/acp/{agent id}` |

The flows exist only when the bridge has `AGENT_ADAPTERS_URL` set. The `acp` flow also needs at least one entry in `AGENTSTUDIO_ACP_AGENTS`.

### A2A (Agent2Agent, JSON-RPC binding v0.3)

- **Sessions and context.** One AgentStudio session is one A2A context. The adapter keeps the `contextId` the agent returns.
- **Sending.** User messages and asks go out as `message/send` (blocking). An ask becomes a prompt that asks for numbered drafts; the answer is parsed back into drafts.
- **Replies.** An agent `Message` becomes a chat message. A `Task` is followed with `tasks/get` until it is done or needs the user. While the task works, the agent shows the status `working`. Text artifacts and status messages become chat messages, and `failed` / `rejected` show as a warning.
- **`input-required`.**
  - If the status message carries a data part `{"agentstudio/approval": {title, summary?, details?, choices?, expires_in_seconds?}}`, AgentStudio shows an approval card. The user's choice goes back on that task as a data part `{"agentstudio/decision": {"choice": "<key>"}}` plus the choice label as text.
  - Without that data part, the question is shown in chat, and the user's next message continues the task.
- **Auth.** The user's token, if any, is sent as `Authorization: Bearer`.

### ACP (Agent Client Protocol, stdio)

The server operator allows ACP agents in `AGENTSTUDIO_ACP_AGENTS`, a JSON array of `{id, name, description?, command, args?, env?}`. Users pick an agent by id and never supply a command.

- **Process.** Each AgentStudio session runs its own agent process, started on the first message, in `AGENTSTUDIO_ACP_WORKDIR/<session>`. The adapter calls `initialize` without fs or terminal capabilities, then `session/new`.
- **Sending.** Messages and asks become `session/prompt`. The `agent_message_chunk` updates are joined into one reply, and `tool_call` titles update the agent's status.
- **Permissions.** `session/request_permission` becomes an approval card whose choices are the agent's options: `allow_*` maps to approve, `reject_*` to deny. The card expires after 30 minutes, and the agent then gets `cancelled`.

## Connectors on the Mac (Grok Bot, Muse, ChatGPT Dots)

These agents have no API for third parties. The Mac app connects them through the user's own signed-in session and serves this same protocol locally:

- Address: `http://127.0.0.1:18401/c/{instance}`, which listens on loopback only.
- Each instance has its own bearer token.
- The renderer registers an instance with the bridge through the `endpoint` flow.

See `docs/connectors.md`.
