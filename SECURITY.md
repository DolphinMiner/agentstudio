# Security policy

AgentStudio holds sensitive things: your chats, your agents' approvals, and the sign-ins you give its connectors for other services. Please report security problems privately.

## Reporting a vulnerability

- **Use GitHub's private vulnerability reporting:** on the repository page, open **Security → Report a vulnerability**. Only the maintainers see the report.
- **Don't open a public issue, discussion or pull request** for a vulnerability.
- Include what you found, how to reproduce it, which version or commit you tested, and the impact you expect.

We aim to acknowledge a report within 3 working days and to agree on a fix and disclosure date with you. We'll credit you in the release notes unless you'd rather not be named.

## Scope

In scope, for example:

- The connectors' handling of credentials: the encrypted store (`connectors.bin`), the connector host on `127.0.0.1:18401` and its per-instance tokens, the Cue sign-in link catcher.
- `agentstudio-api`: sign-in, sessions, the Matrix token it mints per session, the `/_matrix` proxy, approvals and tasks.
- The agents bridge and the AgentStudio Agent Protocol (callbacks, bearer tokens).
- The Electron app: IPC between the renderer and the main process, external-link handling, the content security policy.

Out of scope:

- Problems in the services AgentStudio connects to (Grok Bot, Muse, ChatGPT, Cue, Matrix homeservers). Report those to their owners.
- The local development stack's default settings (dev-mode email codes shown in `/v1/dev/outbox`, plain HTTP on loopback). It isn't meant to face a network.
- Attacks that need someone who already controls your Mac account.

## Supported versions

AgentStudio is alpha. Fixes land on the main development branch; there are no maintained release branches yet.
