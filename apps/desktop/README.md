# @agentstudio/desktop

Electron (macOS) app: electron 45 + electron-vite 6 + React 19. Screens and test ids follow `docs/clients.md`.

| Command | What |
|---|---|
| `pnpm dev` (or `pnpm dev:desktop` at the root) | Vite dev server + Electron against the local stack |
| `pnpm build` / `pnpm start` | build to `out/`, then run the built app |
| `pnpm typecheck`, `pnpm test` | tsc and vitest (pure helpers) |
| `pnpm e2e:smoke` | build, then Playwright `_electron` smoke test against the running stack (`pnpm dev:up` first) |

Environment:

- `AGENTSTUDIO_SERVER_URL`: server base URL (beats the saved setting; default `http://127.0.0.1:18090`).
- `AGENTSTUDIO_USER_DATA_DIR`: profile directory (settings and the safeStorage-encrypted `session.bin`). Use a fresh one per e2e run.
- `AGENTSTUDIO_MOCK_KEYCHAIN=1`: tests only; safeStorage uses Chromium's mock keychain instead of the login keychain.
- `AGENTSTUDIO_TEST_NOTIFICATIONS=1`: tests only; notifications and the Dock badge are recorded in the main process's `globalThis.__agentStudioNotifications` instead of shown (`docs/clients.md` § Notifications).

Security: `contextIsolation`, `sandbox`, no Node integration; the renderer only sees `window.agentStudioDesktop` (see `src/shared/desktop-api.ts`). The renderer is served from `file://` through a `protocol.handle("file")` interceptor that only serves `out/renderer` and adds a CSP header whose `connect-src` is the server origin (plus its `ws:`/`wss:` origin). Changing the server URL reloads the window so the CSP follows.

Electron's postinstall (binary download) is allowed via `allowBuilds` in `pnpm-workspace.yaml`. If `node_modules/electron/dist` is missing, run `node node_modules/electron/install.js` in this directory.
