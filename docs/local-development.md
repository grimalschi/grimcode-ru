*[Documentation](README.md) → Local development*

# Local development

## Getting it running

```bash
pnpm install
cp .env.example .env
pnpm up
```

`.env` is the only local configuration and nothing generates it: the values shipped in
`.env.example` run as they are. Two are worth setting before the first run — `PROJECT_SLUG`, which
names the Compose project, the cookies and the databases, and `GATEWAY_PORT` if 8080 is taken on
this machine. `PUBLIC_SITE_URL` has to follow the port: it is what ends up in email links and what
decides whether the session cookie is marked `Secure`.

The stack is then at `PUBLIC_SITE_URL`. `/` is the site, `/app/` the application, `/admin` the
panel. The first account you register becomes the owner of the panel.

If Docker refuses to create the network because its address pools are exhausted — which happens on a
machine running many projects and worktrees at once — `pnpm network:allocate` gives this copy a free
subnet of its own and never touches anyone else's.

## Everyday commands

| | |
| --- | --- |
| `pnpm up` / `pnpm down` | Start and stop the stack |
| `pnpm logs <service>` | Follow one service |
| `pnpm check` | Lint, types, unit tests, production build, boundaries, service ids, Compose |
| `pnpm test:acceptance` | 54 HTTP checks against the running stack |
| `pnpm test:browser` | 27 Chromium checks |

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

Ports come out of `PORT_RANGE_START..PORT_RANGE_END`, the range `.env` reserves for worktrees, and
`PUBLIC_SITE_URL` and `ACCEPTANCE_BASE_URL` follow the one it picked.

It also clears away what deleted worktrees left on the machine. A checkout that is gone still has its
Docker network holding address space nothing will ever use again — that is what exhausts Docker's
pools and makes the next stack fail to start. Recognised narrowly: the Compose project label, this
template's `<slug>_internal` name, no container attached, and a slug no live checkout uses. Volumes
are listed rather than removed, because a volume is the database of a branch someone may want back;
the command to remove them is printed.

Running it again **keeps** databases the worktree already has. Replacing them is explicit:

```bash
pnpm bootstrap:worktree --refresh-databases
```

A day's work in a worktree cannot be wiped by re-running it out of habit.

This is the one place a script still writes `.env` for you, and the reason is that a worktree's
values are derived rather than chosen: the main checkout's file is the starting point, and what
must differ — the slug, the ports, the database credentials — is replaced.

## The database

The panel's database browser is at `/admin/database`, owner-only, through Gateway. It is the real
Adminer, themed to match the panel around it; it has no host port in any environment.

`psql` works too — PostgreSQL is published on loopback for exactly that:

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

For a service admin interface, see [the admin panel](admin-panel.md).
