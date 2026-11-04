<p align="center"><img src="apps/desktop/resources/icon.png" alt="" width="128"></p>

<h1 align="center">AgentStudio</h1>

**English** · [简体中文](README.zh-CN.md)

<p align="center">
  <img src="docs/media/hero.jpg" alt="AgentStudio: your people and your agents, in one inbox. The Mac app with a dinner booking from Muse waiting for approval." width="900">
</p>

> [!WARNING]
> **FOR PERSONAL USE ONLY.** AgentStudio is a personal tool for learning and research: run it on your own Mac, with your own accounts, to reach your own agents. **NOT FOR COMMERCIAL USE**, and not for running a service for other people. Use it at your own risk. Read the [Disclaimer](#disclaimer) first.

> **Alpha.** macOS only, and you run it from source with a local development stack. Expect rough edges and breaking changes.

An open-source inbox for your chats and your AI agents. Agents show up as contacts next to the people you talk to. When an agent needs a decision, it sends you an approval card. You can hand any conversation to an agent and get reply drafts back.

Status: early development (v0.1). macOS first: the desktop app (Electron) comes first, then mobile (Expo). Nothing here is hosted yet; everything runs on your Mac.

<p align="center">
  <a href="docs/media/agentstudio-demo.mp4">
    <img src="docs/media/agentstudio-demo.gif" alt="A 75-second tour: chat with a Grok bot and approve its report, ask Muse about the weather and approve a dinner booking, have ChatGPT Dots draft a reply to Leo, and connect Grok Bot, Cue, Muse and ChatGPT" width="820">
  </a>
  <br>
  <sub>A 75-second tour. <a href="docs/media/agentstudio-demo.mp4">Watch it in 4K (MP4)</a>.</sub>
</p>

## What it does

- **One inbox** for chats and agents. People are circles, agents are squircles, and each one carries a small mark for the network or service it lives on.
- **Approvals.** An agent asks, you decide in one tap, from the chat or from the Approvals screen.
- **Ask an agent.** Forward a chat with its context to an agent; its reply drafts come back, ready to edit and send.
- **Agents you already use**, through your own sign-in on the Mac: Grok Bot (every bot of your account, with its own name and avatar), Muse, ChatGPT Dots and Cue (sign in with Manus, or use a Manus API key). Experimental and for personal use only: see [below](#disclaimer).
- **Agents that speak an open protocol**: the [AgentStudio Agent Protocol](docs/agent-protocol.md), A2A, and ACP. Hermes Agent and OpenClaw are recognized and shown with their own icons.

<p align="center">
  <img src="docs/media/approvals.jpg" alt="Agents ask before they act: a Grok bot asks whether to send the weekly report, with Send it and Don't send buttons" width="820">
</p>
<p align="center">
  <img src="docs/media/ask.jpg" alt="Ask an agent about any message: pick an agent and the lines it may read, and get reply drafts back" width="820">
</p>
<p align="center">
  <img src="docs/media/connect.jpg" alt="Bring the agents you already use: the Connect screen with Grok Bot, Muse, ChatGPT Dots and Cue, and Grok Bot's two connected bots" width="820">
</p>

## How it is built

| Part | Where | What |
|---|---|---|
| Desktop app | `apps/desktop` | Electron + React. Also hosts the connectors for Grok Bot, Muse, Dots and Cue. |
| Mobile app | `apps/mobile` | Expo / React Native. Tested on the web target until native builds land. |
| Client core | `packages/core` | Matrix client, inbox, approvals, tasks; shared by both apps. |
| Brand assets | `packages/brand` | Official images of the services AgentStudio connects to, with sources. |
| Server | `server` (Go) | `agentstudio-api`, the `agentstudio-agents` and `demo` bridges (mautrix bridgev2), protocol adapters, the reference agent. |
| Homeserver | Synapse | Matrix underneath every chat, federation off. |
| Dev stack | `dev/stack.mjs` | Starts everything locally as native processes, no Docker. |
| End-to-end tests | `e2e` | Playwright against the Electron app and the mobile web build. |

More in [docs/architecture.md](docs/architecture.md). Other docs: [API](docs/api.md), [clients](docs/clients.md), [design](docs/design.md), [Matrix events](docs/matrix-events.md).

## Quick start (macOS)

Requirements: Go 1.26+, Node 22+, pnpm, Homebrew PostgreSQL 18, uv.

```bash
pnpm install
pnpm dev:up        # Postgres, Synapse, API, bridges, reference agents (first run: about 30 s)
pnpm dev:desktop   # Electron app (dev mode) against the local stack
pnpm dev:mobile    # mobile app on the Expo web target: http://localhost:18300
```

There's no account to create: the stack runs in local mode, so the app opens straight to your inbox.
(To try email sign-in instead, pick "Sign in with email instead" after signing out. In dev mode the code isn't mailed; it is shown at
`http://127.0.0.1:18090/v1/dev/outbox?email=<your email>` and in `.local/logs/api.log`.)
Then, on the Connect screen, add the **Demo** network (simulated contacts) and the **Concierge** agent, or sign in to one of the agents you already use.

Managing the stack:

```bash
pnpm dev:status          # what's running
pnpm dev:restart <name>  # restart one service, e.g. api, agents
pnpm dev:logs <name>     # follow a service's log
pnpm dev:down            # stop everything
pnpm dev:reset           # stop and delete all local data in .local/
```

All runtime state (databases, Synapse, logs) lives in `.local/`, which is git-ignored.

## Tests

```bash
pnpm test        # unit tests: stack manager, Go, TypeScript
pnpm test:e2e    # Playwright: Electron app + mobile web, against the local stack
```

If the Electron binary is missing after `pnpm install` (pnpm can skip its postinstall), run
`node node_modules/electron/install.js` in `apps/desktop`. Install Playwright's Chromium with
`pnpm --filter @agentstudio/e2e exec playwright install chromium`.

## Connecting agents

| Agent | How |
|---|---|
| Concierge (built-in reference agent) | Connect → Agents on your server → Concierge |
| Any AgentStudio Agent Protocol endpoint | Connect → AgentStudio agent endpoint, then its URL and token |
| A2A agents (for example Hermes Agent) | Connect → A2A agent, then the agent's URL |
| ACP agents allowed by the server (`AGENTSTUDIO_ACP_AGENTS`) | Connect → ACP agent |
| Grok Bot, Muse, ChatGPT Dots, Cue (Mac app only, experimental) | Connect → Agents you already use. Your sign-in (or Cue's API key) stays on the Mac, and these agents answer while AgentStudio is open. |

Read [the note on third-party connectors](#disclaimer) before connecting Grok Bot, Muse, Dots or Cue.

To debug a connector, start the app with `AGENTSTUDIO_CONNECTOR_TRACE=1` (and `AGENTSTUDIO_CONNECTOR_SHOW=1` to see the hidden Muse / Dots windows). See [docs/connectors.md](docs/connectors.md).

## Disclaimer

**⚖️ FOR PERSONAL LEARNING AND RESEARCH USE ONLY.** Read this before you use AgentStudio, and in particular its connectors for Grok Bot, Muse, ChatGPT Dots and Cue.

- **Personal use only.** Use AgentStudio on your own Mac, with your own accounts, to reach your own agents. Don't use it commercially, to run a service for others, to automate at scale, or with accounts that aren't yours.
- **Local only.** Everything runs on your Mac. Your sign-ins stay there, encrypted with the system keychain; AgentStudio uploads nothing to any server of ours (there is none).
- **Not affiliated.** AgentStudio isn't affiliated with or endorsed by xAI / SpaceX AI, Cursor (Anysphere), Meta, OpenAI, Manus, Nous Research or OpenClaw. Their names and logos are trademarks of their owners and appear only to say which service a connector reaches.
- **Unofficial connectors.** Except for Cue's messaging (Manus's documented API), the connectors work the way each service's own app or website does. That may be against a service's terms, and it can stop working at any time.
- **Your responsibility.** You are responsible for following each service's terms and the laws where you live. If you aren't sure, don't connect it.
- **Use at your own risk.** AgentStudio comes "as is", without warranty of any kind (see the Apache-2.0 license). The authors aren't liable for any loss, account restriction or other consequence of using it.

Details per service: [docs/connectors.md](docs/connectors.md).

## Contributing and security

- [CONTRIBUTING.md](CONTRIBUTING.md): how to set up, test and send a change.
- [SECURITY.md](SECURITY.md): how to report a vulnerability privately. Please don't open a public issue for one.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

Apache-2.0. Third-party notices are in [NOTICES.md](NOTICES.md); brand images belong to their owners (see [packages/brand/README.md](packages/brand/README.md)).
