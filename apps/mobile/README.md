# @agentstudio/mobile

The AgentStudio mobile app: Expo SDK 58, React Native 0.88, React Navigation 7, on top of `@agentstudio/core`.
In v0.1 it is developed and tested on the **web target** (react-native-web), because the dev machine has no Xcode or Android SDK. The code stays native-capable: no web-only APIs in shared paths, and `Platform.OS` checks where platforms differ.

## Commands

Run from this directory, or with `pnpm --filter @agentstudio/mobile <script>`. The local stack must be up (`pnpm dev:up` at the repo root).

| Script | What |
|---|---|
| `pnpm web` | Expo dev server for web on http://127.0.0.1:18300 (root alias: `pnpm dev:mobile`) |
| `pnpm build:web` | static export (`expo export -p web`) into `web-build/` |
| `pnpm serve:web` | serve `web-build/` on 127.0.0.1:18300 with an SPA fallback (`scripts/serve-web.mjs`, no deps; env `PORT`, `HOST`, `WEB_BUILD_DIR`) |
| `pnpm typecheck` | tsc over the app, tests and the smoke spec |
| `pnpm test` | vitest: pure UI logic and the static server |
| `pnpm e2e:smoke` | build:web, then Playwright (Chromium, iPhone 15 emulation) against the stack; screenshots go to `e2e-smoke/artifacts/` |
| `pnpm start` | plain `expo start` (for a future native dev client) |

The server URL is baked in at bundle time from `EXPO_PUBLIC_AGENTSTUDIO_SERVER_URL` (default `http://127.0.0.1:18090`).

## Layout

- `index.ts`: entry; loads `src/polyfills.ts` first.
- `src/App.tsx`: session gate (sign in or workspace).
- `src/screens/`: `SignIn`, `Workspace` (navigation), `Inbox`, `Chat`, `Approvals`, `Tasks`, `Connect`, `Settings`.
- `src/components/`: `TabBar`, `AskSheet`, `ApprovalCard`, `DraftsCard`, `LoginStepView`, `QrCode` (drawn with Views), `ui` primitives.
- `src/lib/`: `services` (ApiClient, SessionManager), `sessionStore` (secure store or localStorage), `runtime` (Matrix client and stores per session), `theme` (light/dark), `logic` (pure, unit tested), `testProps` (`tid()` helper for `data-*` attributes).

Navigation: bottom tabs Inbox / Approvals / Tasks / Connect / Settings (custom tab bar with the `nav-*` ids and `nav-approvals-badge`). Inbox is a stack (list, then chat), so the tab bar stays visible in a chat. Opening a chat from a chat replaces it, and leaving the Inbox tab pops back to the list.

## Test ids on React Native

`testID` becomes `data-testid` on web. Extra attributes from `docs/clients.md` (`data-room-name`, `data-sender`, `data-own`, `data-step-type`, `data-network`, `data-state`) are passed through react-native-web's `dataSet` via `tid(id, data)`, so the mobile web DOM matches desktop. Chat rows also set `accessibilityLabel` to the room name and contain a `chat-row-name` element. Mobile adds `chat-back` (back to the list). On web every askable message has a small visible `message-ask` button; on native, long-press opens a menu with `message-ask`.

## Native status (not yet verified on a device)

- `npx expo export -p ios` and `-p android` bundle and compile to Hermes bytecode. Nothing has run on a simulator or device.
- Session storage uses `expo-secure-store` on native and `localStorage` on web (`src/lib/sessionStore.ts`).
- `crypto.getRandomValues` / `randomUUID` come from `expo-crypto` on native (`src/polyfills.ts`). URL, TextEncoder, structuredClone and AbortController come from React Native and Expo's runtime.
- matrix-js-sdk runs with its in-memory store (no IndexedDB on native), so each launch does a fresh initial sync. Crypto (E2EE) is never initialised.
- Still to do for native: a dev client build with Xcode, keyboard handling checks, push notifications (out of scope for v0.1).
