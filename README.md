# Grimcode project template

A working product with its boring parts already done: a public site, an application behind sign-in,
an admin panel with roles and grants, email with a real editor, and a database interface — eight
services that already talk to each other.

Copying this repository gives a project its first day back.

```bash
pnpm install
pnpm bootstrap
pnpm up
```

The stack prints where it is. `/` is the site, `/app/` the application, `/admin` the panel. The
first account you register becomes the owner.

## What is inside

| | |
| --- | --- |
| **gateway** | The only door: routing, allowlists, the admin decision |
| **site** | Public pages, server-rendered |
| **app** | Sign-in, onboarding, one settings screen |
| **admin** | Roles, grants, audit, and the shell the service admins are composed into |
| **auth** | Identity, sessions, passwords, recovery, security log |
| **users** | The product profile and preferences |
| **notifications** | Typed events, deduplicated, routed |
| **email** | Templates, a self-hosted editor, transports, the delivery log |
| **adminer** | The real Adminer, owner-only, through Gateway |

## Documentation

- [Architecture](docs/architecture.md) — how the pieces fit and why they are split this way
- [Local development](docs/local-development.md) — running it, worktrees, checks
- [Deployment](docs/deployment.md) — what a deployment supplies
- [Administrator access](docs/admin-access.md) — roles, grants, the first owner
- Each service has its own README next to its code
- [Acceptance tests](tests/README.md) — what is verified against a running stack

## Checks

```bash
pnpm check
```

Lint, types, unit tests, the production build, service boundaries, service ids and the Compose
topology. Against a running stack there are two more: `pnpm test:acceptance` and `pnpm test:browser`.

## The specification

- `DIRECTIVES.md` — the owner-controlled project rules. Only the owner edits it.
- `BOILERPLATE_SPEC.md` — the full implementation and acceptance specification this was built from.
- `AGENTS.md` — the reading order for coding agents.
