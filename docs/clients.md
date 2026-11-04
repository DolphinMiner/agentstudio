# Clients: screens, behaviour and test ids

The desktop (Electron) and mobile (Expo) apps implement the same flows on top of `@agentstudio/core`. E2e tests select elements only by `data-testid`. On React Native the same strings go in `testID`, which react-native-web renders as `data-testid`. The `data-*` attributes below (`data-room-name`, `data-sender`, `data-own`, `data-step-type`, `data-network`, `data-state`) go in react-native-web's `dataSet` prop, so the mobile web build renders the same attributes as desktop (native ignores `dataSet`). The ids below are a contract: do not rename them.

## Startup and configuration

- Server URL comes from these sources, in order:
  - desktop: env `AGENTSTUDIO_SERVER_URL`, then the saved setting, then the default `http://127.0.0.1:18090`
  - mobile: `EXPO_PUBLIC_AGENTSTUDIO_SERVER_URL`, then the same default
- The session (refresh token, matrix credentials) is persisted:
  - desktop: in the Electron `safeStorage`-encrypted file, accessed through preload
  - mobile native: `expo-secure-store`
  - mobile web: `localStorage`
- E2e uses a fresh profile directory or storage each run. Set `AGENTSTUDIO_USER_DATA_DIR` on desktop.

## Screens

### Sign in

| Element | `data-testid` |
|---|---|
| Email input | `signin-email` |
| "Send code" button | `signin-send` |
| Code input | `signin-code` |
| "Sign in" button | `signin-verify` |
| Error text | `signin-error` |

On success the app opens the inbox.

### App shell

| Element | `data-testid` |
|---|---|
| Inbox nav | `nav-inbox` |
| Approvals nav | `nav-approvals` (shows pending count badge `nav-approvals-badge`) |
| Tasks nav | `nav-tasks` |
| Connect nav | `nav-connect` |
| Settings nav | `nav-settings` |

On mobile, these are bottom tabs with the same ids. The chat is a stack screen inside the Inbox tab, so the tab bar stays visible in a chat; leaving the Inbox tab returns it to the chat list, and opening a chat from a chat replaces it (at most one chat is mounted).

### Inbox

| Element | `data-testid` |
|---|---|
| Filter tabs | `inbox-filter-all`, `inbox-filter-agents`; mobile also has `inbox-filter-people` (the Mac app has no People filter for now) |
| List | `chat-list` |
| One row per room | `chat-row` with attribute `data-room-name="<name>"`. On RN the row also has `accessibilityLabel` = the name and a nested `chat-row-name` element with the name. |
| Unread badge in a row | `chat-row-unread` |
| Network label in a row | `chat-row-network` (e.g. "Demo", "Agent") |
| Empty state | `inbox-empty` with a "Connect an account" button `inbox-connect` |

- Rows are sorted by last activity.
- Agent rows show the agent status text (`chat-row-status`) and a "Needs you" marker (`chat-row-needs-you`) when the agent has pending approvals.

### Chat (room view)

| Element | `data-testid` |
|---|---|
| Header with name | `chat-title` (inside `chat-identity`, which also holds the avatar) |
| Connect step that asks for a value (the Cue API key) | `local-login-input`, `local-login-submit`, `local-login-input-error`, `local-login-link` |
| Connect screen: a service's card / its agents button / summary | `local-service-card-{id}`, `local-service-manage-{id}`, `local-service-summary-{id}` |
| A service's agents sheet (rows, close, check for new agents) | `local-sheet`, `local-connector-row`, `local-sheet-close`, `local-sheet-add` |
| Extra button while a connect step waits (e.g. "Use an API key instead") | `local-login-action-{id}` |
| "Waiting on you" row above the list (desktop, All only; agents with a pending approval or at work) | `agent-waiting`, `agent-waiting-item`, `agent-waiting-more` |
| Agents needing attention: banner, its button; a row's status ("Sign in again") | `agent-trouble`, `agent-trouble-fix`, `chat-row-status` |
| One-time note about agents on this Mac | `local-mode-note`, `local-mode-note-ok` |
| Message parts: an image / a file an agent sent; "In Grok Bot" under what the user wrote in the service's app | `message-image`, `message-file`, `message-via` |
| Settings: export diagnostics | `settings-export-diagnostics` |
| Delete a chat (desktop) | `chat-menu` → `chat-delete` → `chat-delete-confirm` (leaves and forgets the room) |
| Notifications from an agent (desktop, agent chats) | `chat-menu` → `chat-notify-all`, `chat-notify-approvals`, `chat-notify-mute` (`role="menuitemradio"`, the current one has `aria-checked="true"`) |
| A real picture in an avatar (person's or agent's own) | `avatar-image` |
| A person's initials, when they have no picture (agents never show initials) | `avatar-initials` |
| Network label | `chat-network` |
| Timeline | `timeline` |
| Each message | `message` with attributes `data-sender` (display name) and `data-own="true\|false"`. On RN, testID `message`. |
| Message body | `message-body` |
| Composer input | `composer-input` |
| Send button | `composer-send` |
| Failed send | `message-failed` |
| Back to the chat list (mobile only) | `chat-back` |

Opening a message's actions (hover menu on desktop, long-press on mobile) shows "Ask an agent" `message-ask`. The mobile web build also shows a small always-visible `message-ask` button beside each askable message, since long-press is awkward with a mouse.

**Approval card** (rendered for a `com.agentstudio.approval` message):

| Element | `data-testid` |
|---|---|
| Card | `approval-card` |
| Title | `approval-title` |
| Details rows | `approval-detail` |
| Choice buttons | `approval-choice-<key>`, e.g. `approval-choice-book` |
| State after decision | `approval-state`, text "Approved: Book" / "Declined: Don't book" / "Expired" |
| Countdown | `approval-expiry`, e.g. "44 min left" |

**Drafts card** (for `com.agentstudio.drafts`):

| Element | `data-testid` |
|---|---|
| Card | `drafts-card` |
| Each draft | `draft-item` |
| "Use" button per draft | `draft-use` |

"Use" opens the origin chat with the draft text placed in its composer, editable and not auto-sent. When the user sends it, the client calls `POST /v1/tasks/{id}/sent`.

### Ask an agent (modal or sheet)

| Element | `data-testid` |
|---|---|
| Agent picker | `ask-agent-<agent name>`, e.g. `ask-agent-Concierge` |
| Request input | `ask-request` (default "Draft a reply") |
| Context preview: up to 5 lines (anchor + 4 prior) with checkboxes | `ask-line` + checkbox `ask-line-toggle` |
| "Don't ask again for this agent" | `ask-dont-ask` |
| Send | `ask-send` |
| Cancel | `ask-cancel` |

- The preview is skipped when the agent's consent says `ask_without_preview`.
- Lines from senders known only by a phone number or email are shown already anonymized (`Person 1`).
- After sending, the app navigates to the agent's chat.

### Approvals screen

| Element | `data-testid` |
|---|---|
| List of pending approvals | `approvals-list` |
| Each approval | an `approval-card` (same component as in chat) |
| Empty state | `approvals-empty` |

### Tasks screen

| Element | `data-testid` |
|---|---|
| Board | `tasks-board` |
| Columns | `tasks-col-pending`, `tasks-col-answered`, `tasks-col-done` |
| Each task | `task-card` with `data-state` |

### Connect

| Element | `data-testid` |
|---|---|
| Network section heading (desktop) / network card (mobile) | `network-<id>`, e.g. `network-demo`, `network-agentstudio-agents` |
| Flow "Connect" button | `flow-<id>`, e.g. `flow-concierge`, `flow-endpoint`, `flow-demo`. On desktop the login runs in a sheet that closes itself 1.5 s after `login-complete`. |
| Login step renderer | `login-step` with attribute `data-step-type` |
| `user_input` fields | `login-field-<id>` |
| Submit | `login-submit` |
| QR / code display | `login-qr`, `login-code` |
| Complete message | `login-complete` |
| Connected accounts list | `connection-row` with `data-network` and `data-state`, plus a remove button `connection-remove` |

### Settings

| Element | `data-testid` |
|---|---|
| Account email | `settings-email` |
| Server URL | `settings-server` |
| Sign out | `settings-signout` |
| Version | `settings-version` |
| System notifications switch (desktop) | `settings-notifications` (a checkbox) |
| Notifications per agent (desktop) | `settings-agent-notify`, one `<select>` per agent with `data-agent-name="<agent name>"` and the values `all`, `approvals`, `mute` |

## Behaviour rules

- **Auto-join:** the client auto-joins invites from bridge bots and ghosts on its own homeserver (see `matrix-events.md`).
- **Hidden rooms:** management rooms with a bridge bot are hidden.
- **Pending approvals:** the badge refreshes when a `com.agentstudio.approval` event arrives, and every 15 s while the app is visible.
- **Sending:** sends are optimistic. On failure the message shows `message-failed` with a retry.
- **Ask anonymization:** handled in `@agentstudio/core` (`buildAskQuote`), so both apps behave the same.

## Notifications and the Dock badge (desktop only)

`@agentstudio/core` decides what to notify (`NotificationCenter` in `notifications.ts`); the renderer hands each notification to the main process through the preload (`agentStudioDesktop.notifications`), which shows it and keeps the settings in `settings.json`.

- **What:**
  - a new approval: the approval's title, with the agent's name as the body; it opens Approvals
  - an agent's reply: the agent's name and the start of the message; it opens the chat
  - an agent that needs a new sign-in or has an error (its connector on this Mac, or an agent reported offline): it opens Connect
  - a message from a person: the chat's name and the message; it opens the chat
- **Priority:** approvals make a sound and stay where the platform allows it. Agent replies and problems are normal notifications. People's messages are silent, and a newer one replaces the older one from the same chat.
- **When not:**
  - nothing from the first sync, and nothing older than 2 minutes when it arrives, by the event's own timestamp (bridge backfill, imported history, catch-up after sleep)
  - edits (`m.replace`)
  - nothing about the chat (or, for approvals, the Approvals screen) the user is looking at in a focused window
  - own messages and bridge bot notices
- **Settings:** a master switch (`settings-notifications`, on by default) and a mode per agent: all notifications, approvals only, or mute (`settings-agent-notify`, or `chat-notify-*` in the chat menu). They are saved by the main process and survive a restart. macOS asks for permission with the first notification; if nothing was shown yet, turning the switch on or the first badge count shows one "Notifications are on" notification so it asks (the Dock badge needs the permission too).
- **Dock badge:** pending approvals plus unread messages in agent chats, the same numbers as `nav-approvals-badge` and the agent rows' `chat-row-unread`. At 0 the badge goes away.
- **Background:** on macOS, closing the window hides it, so the app keeps syncing and notifying until the user quits.
- **Tests:** with `AGENTSTUDIO_TEST_NOTIFICATIONS=1` the main process records notifications and the badge in `globalThis.__agentStudioNotifications` (`{ shown, badge, click(i) }`) instead of showing them; e2e reads them with `electronApp.evaluate`.

## Agents on this Mac (desktop only)

This is a section of the Connect screen for agents connected through the user's own session, running in the Mac app (`docs/connectors.md`).

| Element | `data-testid` |
|---|---|
| Section | `local-agents` |
| Service cards | `local-service-<id>`, one each for `local-service-grokbot`, `local-service-muse` and `local-service-dots` |
| Connect-flow panel | `local-login` |
| Flow status text | `local-login-status` |
| Cancel | `local-login-cancel` |
| Error | `local-login-error` |
| Choice buttons (e.g. which Grok bot) | `local-login-choice-<id>` |
| Connector rows | `local-connector-row`, with `data-service` and `data-status` (`ready`, `starting`, `needs_login`, `error`) |
| Row buttons | `local-connector-open` (shows the service's own window), `local-connector-remove` |

Connecting signs in to the service:

- **Grok Bot:** in the browser.
- **Muse and Dots:** in an AgentStudio sign-in window.

The app then registers the connector with the agents bridge. After that the agent is a normal contact on every client, but it answers only while the Mac app runs.

Approval cards from connectors use the choice keys the connector sends:

- **Grok Bot:** the widget's values.
- **Page buttons:** `b<index>`.
