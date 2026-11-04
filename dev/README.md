# Local stack

`dev/stack.mjs` runs the whole AgentStudio backend as native macOS processes (no Docker). It is a
dependency-free Node script; the root `package.json` wraps it.

| Command | What |
|---|---|
| `pnpm dev:up` | build Go binaries and start everything; idempotent (healthy services are left alone, dead ones restarted) |
| `pnpm dev:status` | status table: pid, port, health, log file |
| `pnpm dev:restart <service>` | rebuild (Go) and restart one service; templates are re-rendered first |
| `pnpm dev:logs <service>` | `tail -F` one service's log |
| `pnpm dev:down` | stop everything (SIGTERM, SIGKILL after 10 s; `pg_ctl stop -m fast`) |
| `pnpm dev:reset` | `dev:down` and delete `.local/` (all data and secrets) |
| `pnpm dev:env` | print `.local/env` (contains secrets) |

Services, in start order (`<service>` names also accept `agentstudio-api`, `agentstudio-bridge-demo`, ...):

| Service | Port | Health check | Started as |
|---|---|---|---|
| `postgres` | 54329 | `pg_isready` | `pg_ctl start` on the private cluster `.local/pg` |
| `synapse` | 18008 | `GET /_matrix/client/versions` | `.local/synapse-venv/bin/python -m synapse.app.homeserver` |
| `concierge` | 18201 | `GET /health` | `.local/bin/agentstudio-agent-concierge` |
| `adapters` | 18202 | `GET /health` | `.local/bin/agentstudio-agent-adapters` (also builds `agentstudio-dev-acp-echo`, the dev ACP agent) |
| `a2a-echo` | 18203 | `GET /health` | `.local/bin/agentstudio-dev-a2a-echo` (dev only) |
| `api` | 18090 | `GET /healthz` | `.local/bin/agentstudio-api` |
| `demo` | 18101 | `GET /_matrix/mau/live` | `.local/bin/agentstudio-bridge-demo -n -c .local/bridges/demo.yaml -r .local/synapse/registration-demo.yaml` |
| `agents` | 18102 | `GET /_matrix/mau/live` | `.local/bin/agentstudio-bridge-agents -n -c .local/bridges/agents.yaml -r .local/synapse/registration-agents.yaml` |

Everything binds to 127.0.0.1 only.

## Requirements

Go 1.26, Node 22+, pnpm, Homebrew PostgreSQL (`initdb`, `pg_ctl`, `pg_isready`, `psql` on PATH) and `uv`.
The first `dev:up` creates a Python 3.12 venv and installs `matrix-synapse[postgres,jwt]==1.164.1`
(psycopg2 compiles against Homebrew's `pg_config`).

## What lives in `.local/`

| Path | What |
|---|---|
| `env` | generated environment (see below), mode 0600 |
| `pg/` | Postgres cluster: user `agentstudio`, trust auth, UTF8, locale C. Our settings are in `pg/agentstudio.conf` |
| `run/` | pid files and the Postgres unix socket |
| `logs/<service>.log` | stdout/stderr of each service, appended across restarts |
| `bin/` | Go binaries |
| `synapse/` | rendered `homeserver.yaml`, `registration-{demo,agents}.yaml`, signing key, media store |
| `synapse-venv/` | Synapse virtualenv |
| `bridges/{demo,agents}.yaml` | rendered bridge configs |

Databases: `synapse`, `agentstudio`, `bridge_demo`, `bridge_agents`.

## Environment (`.local/env`)

Every service process gets these variables. Load them into a shell with `set -a; . .local/env; set +a`.

- Secrets, generated once with `crypto.randomBytes` and kept until `dev:reset`:
  `AGENTSTUDIO_TOKEN_SECRET`, `AGENTSTUDIO_INTERNAL_SECRET`, `SYNAPSE_JWT_SECRET`, `SYNAPSE_REGISTRATION_SECRET`,
  `SYNAPSE_MACAROON_SECRET`, `SYNAPSE_FORM_SECRET`, `DEMO_AS_TOKEN`, `DEMO_HS_TOKEN`, `AGENTS_AS_TOKEN`,
  `AGENTS_HS_TOKEN`, `DEMO_PROVISION_SECRET`, `AGENTS_PROVISION_SECRET`.
- Constants, rewritten on every run: `AGENTSTUDIO_DEV=1`, `AGENTSTUDIO_SERVER_URL`, `AGENTSTUDIO_API_ADDR`,
  `SYNAPSE_URL`, `SYNAPSE_PORT`, `MATRIX_SERVER_NAME=agentstudio.local`, `DEMO_BRIDGE_URL`, `AGENTS_BRIDGE_URL`,
  `AGENTSTUDIO_CONCIERGE_URL`, `CONCIERGE_ADDR`, `MOBILE_WEB_URL`, `PG_PORT`, `AGENTSTUDIO_LOCAL_DIR`, and the
  Postgres URLs `AGENTSTUDIO_DATABASE_URL`, `BRIDGE_DEMO_DATABASE_URL`, `BRIDGE_AGENTS_DATABASE_URL`,
  `SYNAPSE_DATABASE_URL` (`postgres://agentstudio@127.0.0.1:54329/<db>?sslmode=disable`).

To add a variable, add it to `CONSTANTS` or `SECRET_KEYS` in `stack.mjs`.

## Config templates (`dev/config/`)

`*.tmpl` files are rendered on every `dev:up` / `dev:restart`. Placeholders are `$` + `{NAME}` where
NAME is any `.local/env` key, `LOCAL_DIR` or `SYNAPSE_DIR`; an unknown name is an error. Go template
syntax such as `{{.}}` is left untouched.

- `homeserver.yaml.tmpl`: Synapse. Client listener only, federation off, registration off,
  `jwt_config` (HS256, `SYNAPSE_JWT_SECRET`, `sub`) for agentstudio-api logins, both appservice
  registrations, rate limits effectively disabled.
- `registration-{demo,agents}.yaml.tmpl`: appservice registrations (`sender_localpart` `demobot` /
  `agentsbot`, exclusive `@demo_.*` / `@agents_.*` namespaces, ephemeral events on).
- `bridge-{demo,agents}.yaml.tmpl`: bridgev2 configs, based on mautrix-go v0.32.0's
  `bridgev2/matrix/mxmain/example-config.yaml`. Keys you leave out take the example's default (mxmain
  merges in memory). Bridges run with `-n`, so the rendered file is never rewritten. The `network:`
  section is for the bridge's own `NetworkConnector.GetConfig()`. Logging stays at `info`: at `debug`,
  mautrix logs HTTP request bodies, which include message content.

## Go builds

The stack builds with `go build -tags nocrypto -o .local/bin/<name> ./cmd/<name>` from `server/`.
`nocrypto` is required: without it mautrix links libolm (`olm/olm.h` not found). If a build fails,
the error is printed and the previous binary (if any) is started, so one broken service does not
block the rest.

## Quick checks

```bash
# Synapse JWT login (what agentstudio-api does), with node:
set -a; . .local/env; set +a
node -e '
const c=require("crypto"),b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");
const u=b({alg:"HS256",typ:"JWT"})+"."+b({sub:"u_check"});
const t=u+"."+c.createHmac("sha256",process.env.SYNAPSE_JWT_SECRET).update(u).digest("base64url");
fetch(process.env.SYNAPSE_URL+"/_matrix/client/v3/login",{method:"POST",body:JSON.stringify({type:"org.matrix.login.jwt",token:t})}).then(r=>r.json()).then(j=>console.log(j.user_id))'

# Appservice registration loaded:
curl -s -H "Authorization: Bearer $DEMO_AS_TOKEN" $SYNAPSE_URL/_matrix/client/v3/account/whoami
# => {"user_id":"@demobot:agentstudio.local",...}

# Postgres shell:
psql -h 127.0.0.1 -p 54329 -U agentstudio agentstudio
```

## Troubleshooting

- **A service is `stopped` or `unhealthy`.** `dev:up` prints the last log lines; see
  `.local/logs/<service>.log` for more. Fix and run `pnpm dev:restart <service>`.
- **Postgres: "postmaster became multithreaded during startup".** A macOS locale problem; the stack
  starts Postgres with `LC_ALL=C`. If you run `pg_ctl` by hand, do the same.
- **Port already in use.** Something else listens on a stack port. `lsof -nP -iTCP:<port> -sTCP:LISTEN`.
  A service that is healthy but has no live pid file is reported as "not managed by this stack" and
  left alone.
- **Synapse venv broken or Synapse version bumped.** The venv is reinstalled when the pinned version
  in `stack.mjs` changes. To force it: `pnpm dev:down && rm -rf .local/synapse-venv && pnpm dev:up`.
- **Bridge exits with "Configuration error".** Check `.local/bridges/<x>.yaml` against the
  template; mxmain names the offending field in `.local/logs/<x>.log`.
- **Appservice token mismatch / bridge says "unknown token".** Bridge config and registration
  are rendered from the same `.local/env`. After changing tokens, restart both `synapse` and the bridge.
- **Start over.** `pnpm dev:reset && pnpm dev:up` wipes all users, rooms and secrets. Do not do this
  while someone else is running tests against the stack.
