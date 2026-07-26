# Local development

## Getting it running

```bash
pnpm install
pnpm bootstrap
pnpm up
```

`bootstrap` writes the git-ignored `.env`: it picks the project slug, finds free ports, generates
secrets and prints where the stack will be. It never overwrites a value a human already put there,
so running it again is safe.

Nobody types a port number. If Docker's address pools are exhausted — which happens on a machine
running many worktrees — bootstrap also picks a free subnet for this copy. It never touches anyone
else's Docker network.

The stack is then on the port it printed. `/` is the site, `/app/` the application, `/admin` the
panel. The first account you register becomes the owner of the panel.

## Everyday commands

| | |
| --- | --- |
| `pnpm up` / `pnpm down` | Start and stop the stack |
| `pnpm logs <service>` | Follow one service |
| `pnpm check` | Lint, types, unit tests, production build, boundaries, service ids, Compose |
| `pnpm test:acceptance` | 51 HTTP checks against the running stack |
| `pnpm test:browser` | 24 Chromium checks |

`pnpm check` is what has to be green. It runs from a clean checkout with the single lockfile and
needs no running stack.

## Reaching it from another machine

The gateway binds to loopback by default. To reach the stack from the host of a virtual machine, or
from a phone on the same network:

```bash
GATEWAY_BIND_HOST=0.0.0.0
```

in `.env`. `POSTGRES_BIND_HOST` is separate on purpose — opening the application must not drag the
database out with it.

## Worktrees

A worktree is a separate checkout on another branch, with its own Compose project, its own
PostgreSQL container, its own volume and its own ports. Worktrees never share a database: one branch
changing a schema would break the other.

```bash
git worktree add ../project-feature -b feature
cd ../project-feature
pnpm install
pnpm bootstrap:worktree
```

It finds the main checkout through git rather than a path written down anywhere, carries its `.env`
over, replaces what must differ, and copies the local service databases across with a logical dump
and restore — so the new branch starts with the data you were already working with.

Running it again **keeps** databases the worktree already has. Replacing them is explicit:

```bash
pnpm bootstrap:worktree --refresh-databases
```

A day's work in a worktree cannot be wiped by re-running bootstrap out of habit.

## The database

Adminer is at `/admin/service/adminer/`, owner-only, through Gateway. It is the real Adminer, themed
to match the panel; it has no host port in any environment.

`psql` works too — bootstrap published PostgreSQL on loopback for exactly that:

```bash
node scripts/compose.mjs exec postgres psql -U "$POSTGRES_USER" -d "${PROJECT_SLUG}_auth"
```

## The checks, and what each is for

| Script | Refuses |
| --- | --- |
| `check-boundaries.mjs` | A service importing another service, type-only imports included |
| `check-service-ids.mjs` | A service known to Gateway but invisible in the Admin shell, or the reverse; Adminer being public or grantable |
| `check-compose.mjs` | Anything but Gateway published locally; anything at all published in production; a PostgreSQL container in production |

They exist because each protects a rule that is easy to break by accident and hard to notice.

## Adding a service

1. Its contract in `contracts/`, split into public, internal and admin surfaces.
2. The service under `services/`, with its own migrations if it stores anything.
3. Its id in `ADMIN_SERVICE_IDS` and — only if it should be reachable without a session — in
   Gateway's public allowlist.
4. Its entry in the Admin shell's [`services.ts`](../services/admin/web/src/services.ts).
5. Its service in `docker/compose.yaml` and `docker/compose.production.yaml`.

`check-service-ids.mjs` will tell you if you missed one of the three places ids live.

For a service admin interface, see [that section of the Admin README](../services/admin/README.md).
