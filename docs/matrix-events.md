# Matrix conventions and custom events

- Namespace: `com.agentstudio.*`.
- Homeserver `server_name`: `agentstudio.local`.
- No E2EE: bridges set `encryption.allow: false`, and clients never initialise crypto.

## Room classification (clients)

Clients classify a room by reading its bridge info state event. bridgev2 sends both `m.bridge` and `uk.half-shot.bridge`, with `state_key` = the bridge info key.

- `content.protocol.id` gives the network: `demo`, `agentstudio-agents`, `whatsapp`, `instagram`, `slack`, `linkedin`, ...
- `content.protocol.displayname` gives the human network name.
- A room with no bridge info is a plain Matrix room, network `matrix`.
- An **agent room** is a room whose network is `agentstudio-agents`. The client matches it to `Agent.room_id` from `/v1/agents`.
- Bridge bots (`@demobot:agentstudio.local`, `@agentsbot:agentstudio.local`) invite the user into portal rooms. Clients auto-join invites only when the inviter's localpart ends in `bot` or starts with a known ghost prefix (`demo_`, `agents_`), and the inviter is on `agentstudio.local`.
- Management rooms (the DM with the bridge bot itself) are hidden from the inbox.

Ghost localparts follow bridgev2 `username_template`:

| Bridge | Ghost localpart |
|---|---|
| demo | `demo_{{.}}` |
| agents | `agents_{{.}}` |

## Content keys on `m.room.message`

### `com.agentstudio.ask`

Sent by the user into an agent room for "Ask an agent".

```json
{
  "msgtype": "m.text",
  "body": "Ask: Draft a reply\n\nFrom Leo Park in Demo:\n> Leo Park: Are we still on for 7:15?",
  "com.agentstudio.ask": {
    "v": 1,
    "task_id": "tsk_…",
    "app": "Demo",
    "chat": "Leo Park",
    "request": "Draft a reply",
    "lines": [{ "speaker": "Leo Park", "own": false, "ts": 1762070000000, "text": "Are we still on for 7:15?" }]
  }
}
```

Limits and rules:

- `lines`: at most 5 (the anchor plus 4 prior), sorted oldest first.
- `text`: at most 2000 characters each.
- Senders known only by a phone number or email address become `Person 1`, `Person 2`, ... The user's own lines have `own: true` and speaker `Me`.

### `com.agentstudio.drafts`

Sent by the agent ghost, as `msgtype: "m.notice"`.

```json
{
  "msgtype": "m.notice",
  "body": "Here are 3 drafts:\n1. …\n2. …\n3. …",
  "com.agentstudio.drafts": { "v": 1, "task_id": "tsk_…", "drafts": [{ "text": "…" }] }
}
```

### `com.agentstudio.approval`

Sent by the agent ghost. The card's state always comes from `GET /v1/approvals/{id}`, never from the event.

```json
{
  "msgtype": "m.text",
  "body": "Approval needed: Book the 6pm flight to Toronto for $412?",
  "com.agentstudio.approval": { "v": 1, "approval_id": "apr_…" }
}
```

### `com.agentstudio.from_user`, `com.agentstudio.via`, `com.agentstudio.history`

Markers the agents bridge adds to messages (from the protocol's `message` event):

| Key | Value | Clients |
|---|---|---|
| `com.agentstudio.from_user` | `true` | The user wrote this in the service's own app (for example Grok Bot on their phone). The agent ghost sends it, but clients show it on the user's side. |
| `com.agentstudio.via` | string | With `from_user`: the app's name, shown as "In Grok Bot". |
| `com.agentstudio.history` | `true` | Earlier conversation imported when the agent was connected. Clients don't notify. |

Files an agent sent are ordinary `m.image` / `m.file` events (authenticated media).

## Demo network (`agentstudio-bridge-demo`)

A simulated chat network used for development and e2e. All behaviour is deterministic.

### Login

There is one flow, `demo`, with one `user_input` field `display_name` (type `username`, default "Demo User"). It completes immediately. The `user_login_id` is `demo-<sha256(owner mxid)[:12]>`.

### Contacts and starting messages

After login the bridge creates these portals. Ghost ids are given as `demo_<id>`.

| Portal | Ghost id | Type | Starting messages (backfilled in order, oldest first) |
|---|---|---|---|
| **Mom** | `mom` | DM | "Did you eat yet?" |
| **Leo Park** | `leo` | DM | "Hey! Long time", "Are we still on for 7:15?" |
| **Book Club** | — | group with ghosts `mia` "Mia Chen" and `+15550101` (display name "+1 555 0101") | Mia: "Chapter 4 tonight?", +15550101: "I'm in" |

### Replies

When the user sends text into a demo portal, the bridge confirms it and the first ghost of that portal replies after about 300 ms:

- In a DM, the reply is `Echo: <text>`.
- In Book Club, Mia replies `Echo: <text>`.

Only `m.text` and `m.emote` are bridged (`m.notice` is ignored, as bridgev2's `bridge_notices` is off). Media is rejected: the bridge bot posts an "unsupported message type" notice into the room.

Each demo login gets its own copy of the three portals (`split_portals: true`); the `m.bridge` `channel.id` is the portal id (`mom`, `leo`, `bookclub`). The phone-number ghost's Matrix ID is `@demo_+15550101:agentstudio.local`.

### Test hooks

Dev-only HTTP routes on the bridge listener let e2e inject incoming messages. They are enabled only with `AGENTSTUDIO_DEV=1` and protected by the internal secret:

- `POST /agentstudio/dev/v1/incoming {user_mxid, portal: "mom"|"leo"|"bookclub", sender: "mom"|"leo"|"mia"|"+15550101", text}` returns 202 `{"message_id"}`. It is served on the bridge's appservice listener (`DEMO_BRIDGE_URL`, port 18101) with `Authorization: Bearer <AGENTSTUDIO_INTERNAL_SECRET>`. Errors use the API error shape: 401 `unauthenticated`, 400 `bad_request` (unknown portal, or a sender that is not in that portal), 404 `not_found` (the user has no demo login).
