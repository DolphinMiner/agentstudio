# @agentstudio/e2e

Playwright end-to-end tests for both clients against the local stack.

| Project | Target |
|---|---|
| `desktop` | the built Electron app (`apps/desktop`, `electron-vite build`) launched with `_electron.launch`, a fresh `AGENTSTUDIO_USER_DATA_DIR` per test and `AGENTSTUDIO_MOCK_KEYCHAIN=1` |
| `mobile-web` | the Expo web export (`apps/mobile/web-build`) served on 127.0.0.1:18300, in Chromium with iPhone 15 emulation and a fresh browser per test |

```bash
pnpm test:e2e                                     # from the repo root: dev:up, build both apps, run everything
pnpm --filter @agentstudio/e2e test:desktop             # or test:mobile
E2E_SKIP_BUILD=1 pnpm --filter @agentstudio/e2e e2e  # reuse existing app builds
```

- `global-setup.ts` runs `node dev/stack.mjs up`, waits until `GET /v1/health` reports Synapse and every bridge reachable, then builds the apps (skip with `E2E_SKIP_BUILD=1`; skip the stack step with `E2E_SKIP_STACK=1`).
- Every test signs in a new user (`e2e-<tag>-<random>@example.com`) and reads the code from `GET /v1/dev/outbox`, so tests run in parallel (`E2E_WORKERS`, default 3).
- Incoming demo messages are injected with the demo bridge's dev hook (`docs/matrix-events.md` § Test hooks) using `AGENTSTUDIO_INTERNAL_SECRET` from `.local/env`.
- Specs select only by the `data-testid` contract in `docs/clients.md`. Shared helpers are in `support/app.ts`; the few platform differences (hover vs. visible "Ask" button, mobile `chat-back`, hidden-but-mounted mobile tabs) live there.
- If `pnpm dev:mobile` (Expo dev server) is already on port 18300, the `mobile-web` project reuses it instead of the static build.
- Failure screenshots are attached to the HTML report (`playwright-report/`).

## README media

`media/` makes the README's pictures and demo video (`docs/media`) from the real desktop app on fake data: `readme.media.ts` drives the app and records it, `render.mjs` composes the pictures, the 4K MP4 and the GIF (needs ffmpeg). With the stack running:

```bash
E2E_SKIP_STACK=1 pnpm --filter @agentstudio/e2e media
```

It uses its own fake-agents server (port 18430, `FAKE_AGENTS_MEDIA=1`). With the Grok Bot app installed, Grok bots get the avatars Grok Bot draws.
