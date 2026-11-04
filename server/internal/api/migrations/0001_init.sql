-- AgentStudio API schema v1.

CREATE TABLE users (
    id               text PRIMARY KEY,
    email            text NOT NULL UNIQUE,
    matrix_localpart text NOT NULL UNIQUE,
    created_at       timestamptz NOT NULL DEFAULT now()
);

-- One active sign-in code per email. Codes are stored only as hashes.
CREATE TABLE email_codes (
    email      text PRIMARY KEY,
    code_hash  text NOT NULL,
    attempts   int NOT NULL DEFAULT 0,
    sent_at    timestamptz NOT NULL,
    expires_at timestamptz NOT NULL
);

-- Dev mailer outbox (only written when AGENTSTUDIO_DEV=1).
CREATE TABLE dev_outbox (
    id       bigserial PRIMARY KEY,
    to_email text NOT NULL,
    subject  text NOT NULL,
    code     text NOT NULL,
    sent_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dev_outbox_to ON dev_outbox (to_email, id DESC);

CREATE TABLE sessions (
    id                  text PRIMARY KEY,
    user_id             text NOT NULL REFERENCES users (id),
    device_name         text NOT NULL,
    matrix_device_id    text NOT NULL,
    matrix_access_token text NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    revoked_at          timestamptz
);
CREATE INDEX sessions_user ON sessions (user_id);

-- Every refresh token ever issued for a session. A token is single use: once
-- used_at is set, presenting it again revokes the whole session.
CREATE TABLE refresh_tokens (
    token_hash text PRIMARY KEY,
    session_id text NOT NULL REFERENCES sessions (id),
    expires_at timestamptz NOT NULL,
    used_at    timestamptz
);
CREATE INDEX refresh_tokens_session ON refresh_tokens (session_id);

CREATE TABLE connections (
    id            text PRIMARY KEY, -- "<network>:<user_login_id>"
    user_id       text NOT NULL REFERENCES users (id),
    network       text NOT NULL,
    remote_id     text NOT NULL,
    remote_name   text NOT NULL DEFAULT '',
    state         text NOT NULL,
    state_message text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    removed_at    timestamptz
);
CREATE INDEX connections_user ON connections (user_id);

-- Maps AgentStudio login process ids to the bridge's provisioning login ids.
CREATE TABLE login_processes (
    id               text PRIMARY KEY,
    user_id          text NOT NULL REFERENCES users (id),
    network          text NOT NULL,
    bridge_login_id  text NOT NULL,
    last_step        jsonb,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agents (
    id                  text PRIMARY KEY, -- = connection_id
    user_id             text NOT NULL REFERENCES users (id),
    name                text NOT NULL,
    description         text NOT NULL DEFAULT '',
    avatar_url          text NOT NULL DEFAULT '',
    room_id             text,
    capabilities        text[] NOT NULL DEFAULT '{}',
    status              text NOT NULL DEFAULT 'idle',
    status_text         text NOT NULL DEFAULT '',
    ask_without_preview boolean NOT NULL DEFAULT false,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agents_user ON agents (user_id);

CREATE TABLE approvals (
    id             text PRIMARY KEY,
    version        int NOT NULL DEFAULT 1,
    user_id        text NOT NULL REFERENCES users (id),
    agent_id       text NOT NULL REFERENCES agents (id),
    external_id    text NOT NULL,
    room_id        text,
    event_id       text,
    title          text NOT NULL,
    summary        text NOT NULL DEFAULT '',
    details        jsonb NOT NULL DEFAULT '[]',
    choices        jsonb NOT NULL,
    state          text NOT NULL DEFAULT 'pending',
    decision       text,
    decided_at     timestamptz,
    delivery_state text,
    expires_at     timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (agent_id, external_id)
);
CREATE INDEX approvals_user ON approvals (user_id, created_at DESC);

CREATE TABLE tasks (
    id               text PRIMARY KEY,
    version          int NOT NULL DEFAULT 1,
    user_id          text NOT NULL REFERENCES users (id),
    agent_id         text NOT NULL REFERENCES agents (id),
    state            text NOT NULL DEFAULT 'pending',
    title            text NOT NULL,
    request_text     text NOT NULL,
    origin           jsonb NOT NULL,
    answer           jsonb,
    sent_draft_index int,
    fail_reason      text NOT NULL DEFAULT '',
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_user ON tasks (user_id, created_at DESC);

-- Stored results of idempotent requests, keyed by user, route and client key.
CREATE TABLE idempotency_keys (
    user_id    text NOT NULL,
    route      text NOT NULL,
    key        text NOT NULL,
    status     int NOT NULL,
    response   jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, route, key)
);
