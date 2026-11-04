# AgentStudio: working agreement for humans and coding agents

AgentStudio is an open-source inbox for your chats and your AI agents (Apache-2.0). Read these first; they are the contracts:

- `docs/architecture.md`: scope, processes, ports, layout
- `docs/api.md`: REST API
- `docs/agent-protocol.md`: how agents connect
- `docs/matrix-events.md`: Matrix conventions, custom events, demo network
- `docs/clients.md`: screens and the `data-testid` contract used by e2e
- `docs/connectors.md`: the Mac app's connectors for Grok Bot, Muse, ChatGPT Dots and Cue (personal use only: see README)
- `docs/roadmap.md`: what's done and what's next
- `CONTRIBUTING.md`, `SECURITY.md`: how to contribute, and how to report a vulnerability

When code and these docs disagree, fix whichever one is wrong in the same change. Never leave them out of sync.

## Commands

| Command | What |
|---|---|
| `pnpm install` | install JS workspace deps |
| `pnpm dev:up` | build Go binaries and start the whole local stack (idempotent) |
| `pnpm dev:down` | stop everything |
| `pnpm dev:status` | show process health |
| `pnpm dev:reset` | stop and wipe `.local/` |
| `pnpm dev:desktop` | run the Electron app (electron-vite dev mode) against the local stack |
| `pnpm dev:mobile` | run Expo (web) against the local stack on http://localhost:18300 |
| `pnpm test` | unit tests: stack manager (`node --test dev/stack.test.mjs`), Go (`cd server && go test -tags nocrypto ./...`) and TS (vitest) |
| `pnpm test:e2e` | e2e (Playwright projects `desktop` and `mobile-web`) against the local stack; starts it if needed and builds both apps. See `e2e/README.md` |

Runtime state, logs and generated secrets live in `.local/`, which is git-ignored:

- logs: `.local/logs/<process>.log`
- generated env: `.local/env`

## Conventions

- **Go:**
  - module `github.com/DolphinMiner/agentstudio/server`
  - Go 1.26, `log/slog` for logs, `pgx/v5` for Postgres
  - bridges are built on `maunium.net/go/mautrix` bridgev2
  - always build/test with `-tags nocrypto` (no E2EE in v0.1, so mautrix is built without libolm; plain `go build ./...` fails on `olm/olm.h`)
  - never log message bodies or tokens
- **TypeScript:**
  - strict mode, ESM, pnpm workspaces
  - `@agentstudio/core` must not import DOM, Node or React Native APIs
  - React 19 function components
- **Tests:** select elements only by `data-testid` / `testID` from `docs/clients.md`. Use no sleeps when a condition can be awaited.
- **No Docker.** The local stack runs native processes: Homebrew Postgres 18 in a private cluster under `.local/pg`, and Synapse in a uv venv.
- **Keep diffs focused.** Do not reformat files you did not change.
- **Connectors for third-party services** reach the user's own agents with the user's own account, on the user's Mac. Don't add anything that works at scale, for other people's accounts, or around a service's limits. Never commit real transcripts, tokens or cookies; scrub fixtures to their structure.
