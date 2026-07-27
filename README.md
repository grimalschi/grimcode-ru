# Grimcode project template

A working product with its boring parts already done: a public site, an application behind sign-in,
an admin panel with roles and grants, and email with a real editor — seven services that already
talk to each other.

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
| **app** | Sign-in, the account, one settings screen |
| **admin** | Roles, grants, audit, and the shell the service admins are composed into |
| **auth** | Identity, sessions, passwords, recovery, security log |
| **users** | The product profile |
| **notifications** | Typed events, deduplicated, routed |
| **email** | Templates, a self-hosted editor, transports, the delivery log |
| **database** | A section of the panel: the real Adminer, owner-only, through Gateway |

## Documentation

[**docs/**](docs/README.md) — the architecture, the admin panel, administrator access, local
development and deployment, and the positions this template takes on your behalf.

Each service has its own README next to its code, and the
[acceptance tests](tests/README.md) describe what is verified against a running stack.

## Checks

```bash
pnpm check
```

Lint, types, unit tests, the production build, service boundaries, service ids and the Compose
topology. Against a running stack there are two more: `pnpm test:acceptance` and `pnpm test:browser`.

## Using it as a template

Copy the repository, run the three commands above, and start replacing. The parts most projects
change first are the site's wording, the seed email templates and the product profile; the parts
most projects never touch are Gateway, Auth and the admin panel's own machinery.

`DIRECTIVES.md` holds the owner's project rules and `AGENTS.md` is the reading order for coding
agents.
