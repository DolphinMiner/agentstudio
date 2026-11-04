# Contributing to AgentStudio

Thanks for helping. AgentStudio is alpha, so the code moves fast; small, focused changes are the easiest to review.

## Before you start

- **Bugs:** open an issue with the bug template. For anything security-related, follow [SECURITY.md](SECURITY.md) instead.
- **Features and bigger changes:** open an issue (or a discussion) first, so we can agree on the approach before you write the code. The plan lives in [docs/roadmap.md](docs/roadmap.md).
- **Read the contracts.** [AGENTS.md](AGENTS.md) lists the docs that define how things work (architecture, API, agent protocol, Matrix events, the client test ids, connectors). When code and docs disagree, fix the wrong one in the same change.

## Set up

Requirements: macOS, Go 1.26+, Node 22+, pnpm, Homebrew PostgreSQL 18 and uv.

```bash
pnpm install
pnpm dev:up        # Postgres, Synapse, the API, bridges and reference agents
pnpm dev:desktop   # the Mac app in dev mode
```

More in [README.md](README.md).

## Make the change

- **Go:** build and test with `-tags nocrypto`. Use `log/slog`, and never log message bodies or tokens.
- **TypeScript:** strict mode, ESM. `@agentstudio/core` must not import DOM, Node or React Native APIs.
- **UI:** follow [docs/design.md](docs/design.md). Icons come from Lucide (desktop) and Ionicons (mobile); service images from `packages/brand`. Don't draw icons by hand.
- **Tests:** select elements only by the `data-testid` values in [docs/clients.md](docs/clients.md), and wait for conditions instead of sleeping.
- **Keep diffs focused.** Don't reformat code you didn't change.

### Connectors for other services

Changes to the Grok Bot, Muse, Dots or Cue connectors must keep to their purpose: reaching **your own** agents, with **your own** account, on **your own** Mac. We won't accept changes that make them work at scale, for other people's accounts, or that get around a service's limits or protections. See the note in [README.md](README.md#disclaimer).

When a service changes, start the app with `AGENTSTUDIO_CONNECTOR_TRACE=1` (or `AGENTSTUDIO_CONNECTOR_TRACE_NETWORK=1` for Muse and Dots) and compare with the fakes in `e2e/fakes/agents.ts`. Never commit a real transcript or token; scrub fixtures down to their structure, like `apps/desktop/test/fixtures/grok-entries.json`.

## Test

```bash
pnpm test        # unit tests: stack manager, Go, TypeScript
pnpm test:e2e    # Playwright against the local stack (desktop and mobile web)
```

Run the e2e specs your change touches, for example `cd e2e && npx playwright test specs/local-agents.spec.ts --project desktop`. CI runs the unit tests and type checks on every pull request.

## Send it

- Open a pull request against the development branch with the template filled in: what changed, why, and how you tested it.
- Update the docs in the same pull request when behavior changes.
- By contributing, you agree that your contribution is licensed under the [Apache License 2.0](LICENSE).

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
