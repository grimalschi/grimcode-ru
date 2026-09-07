*[Documentation](README.md) → Local development*

# Local development

## Getting it running

PostgreSQL has to be on the machine. One server usually serves every copy of the project, worktrees
included — what keeps them apart is the slug in the database names, not the server. On Debian or
Ubuntu:

```bash
sudo apt install postgresql
sudo -u postgres createuser --createdb --pwprompt template
```

The account needs `CREATEDB` and nothing more: each module creates its own database on first use.
`DATABASE_URL` in `.env` is where the project reads its port and that account.

Every command below is pnpm's, and the version is the project's own — `packageManager` in the root
manifest names it. Where the Node installation ships corepack, `corepack enable` is all it takes.

Then the project itself:

```bash
pnpm install
cp .env.example .env
pnpm dev
```

`.env` is the only local configuration, and you copy it yourself — the values shipped in
`.env.example` run as they are, once `DATABASE_URL` names the account you just created. Only a
worktree gets the file written for it, derived from this one. `PROJECT_SLUG` is worth setting before
the first run — it names the cookies and the databases, and it is what keeps two copies of the project
apart on one PostgreSQL.

**Keep it to 49 characters of `[a-z0-9_]`.** PostgreSQL truncates identifiers to 63 bytes and does it
silently, and the longest name built from the slug is `<slug>_notifications` — fourteen characters on
top, which is where 49 comes from. At 50 one name quietly loses its last letter; at 60 the suffixes
are down to `_ad`, `_au`, `_em`, `_no`, `_us`, which work and read like nothing; at 61 `admin` and
`auth` both truncate to `…_a` and two modules would share one database. The composer refuses that
last case at startup and nothing catches the ones before it, so the number is worth respecting rather than
discovering.

Ports come from one range, `PORT_RANGE_START..PORT_RANGE_END`. Its first port is the main checkout's
and nothing else may take it; `GATEWAY_PORT` names it and `PUBLIC_SITE_URL` follows, which is what
ends up in email links and what decides whether the session cookie is marked `Secure`.

`pnpm dev` builds what changed and runs the application, and that is the whole of it: the databases
and their schemas appear on their own, module by module, on the first request that needs them. Nothing
else has to be started, and there is nothing to keep in step.

The application is then at `PUBLIC_SITE_URL`. `/` is the site, `/app/` the application, `/admin` the
panel. The first account you register becomes the owner of the panel.

## What the program reads from the environment

`.env` is the whole of it, and three of these have no default: the program refuses to start without
them and names the one it is missing. That is deliberate — each of the three fails quietly if guessed.
A slug guessed as `template` sends the data into `template_*` databases nobody asked for; an origin
guessed as `http://127.0.0.1:8080` puts a local address into verification and recovery mail and drops
`Secure` from the session cookie on an https deployment; a port guessed at all makes the process look
healthy while answering on a port nothing routes to.

| Required | |
| --- | --- |
| `PROJECT_SLUG` | Names the databases and the cookies. **At most 49 characters of `[a-z0-9_]`**, see above |
| `PUBLIC_SITE_URL` | The origin as a visitor sees it. Links in mail are built from it, and its scheme decides whether the session cookie is marked `Secure` |
| `PORT` or `GATEWAY_PORT` | Where to listen. `PORT` first, because that is what a hosting platform sets; `GATEWAY_PORT` is what lets two worktrees run at once |
| `DATABASE_URL` | The server and the one account. Each module swaps in its own database name and creates that database when it is missing, so the account needs `CREATEDB` — and nothing else |

| Optional | |
| --- | --- |
| `AUTH_SESSION_TTL_SECONDS` | How long a session lasts. Thirty days by default |
| `EMAIL_PROVIDER` | `log` records messages in the delivery journal without sending them, which is the default. `unisender` sends through UniSender Go |
| `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME`, `UNISENDER_GO_API_KEY`, `UNISENDER_GO_API_URL` | The transport's own settings. The address is required by the UniSender transport, and it says so when it refuses |
| `PORT_RANGE_START`, `PORT_RANGE_END` | Read by `bootstrap:worktree` alone, to pick a free port for a new branch. The application never looks at them |
| `SCHEMA_SOURCE_ROOT` | Where the database section writes a change of shape, when that is not the project this program was built in. Set for a copy started to run the browser checks, which really do add and drop columns — otherwise every run would leave migrations in the repository under test |
| `DATABASE_URL_ADMIN`, `_AUTH`, `_USERS`, `_NOTIFICATIONS`, `_EMAIL` | One module's database elsewhere — another server, or an account with other rights. Taken exactly as written, and the module creates its database on **that** server. One condition: the database has to be named `<PROJECT_SLUG>_<module>`, because the module refuses a pool that opened anything else (`Pool opened database …, expected …`) |

Nothing else is read: a module is handed what it needs and reaches for the environment through nothing
at all, which a lint rule and a boundary check both refuse.

## Everyday commands

| | |
| --- | --- |
| `pnpm dev` | Build what changed and run the application |
| — | The databases and their migrations need no command: each module creates and migrates its own on its first request |
| `pnpm check` | Lint, types, unit tests, production build, then the six scripts below: dependencies, boundaries, procedures, migrations, service ids, script names |
| `pnpm test:acceptance` | The HTTP checks, against a running application |
| `pnpm test:browser` | The Chromium checks, against a running application |

`pnpm check` is what has to be green. It runs from a clean checkout with the single lockfile and
needs nothing running.

Two things local running does not give you:

- **Error bodies carry a stack.** `NODE_ENV` is not `production` here, so an RPC failure answers with
  more detail than a deployment would.
- **It is your machine's Node.** A deployment has its own, so a green run here is not a green
  deployment — the manifest's `engines` says what the project expects and nothing enforces it.

## Reaching it from another machine

Nothing to configure: the application listens on every interface, so it answers on the machine's
address from the host of a virtual machine or a phone on the same network. PostgreSQL is a separate
matter — a stock installation listens on loopback only, and moving it is a decision about the machine,
not about this project.

The one consequence worth knowing: until an account is registered, whoever registers first becomes
the owner of the panel. On a network you do not control, register immediately after starting.

## Worktrees

A worktree is a separate checkout on another branch, with its own `.env`, its own port and its own
databases — normally on the same PostgreSQL the main checkout uses. Worktrees never share a database:
one branch changing a schema would break the other.

```bash
git worktree add ../project-feature -b feature
cd ../project-feature
pnpm install
pnpm bootstrap:worktree
```

It finds the main checkout through git rather than a path written down anywhere, carries its `.env`
over, replaces what must differ, and copies the local module databases across with a logical dump
and restore — so the new branch starts with the data you were already working with.

The port comes out of `PORT_RANGE_START..PORT_RANGE_END`, never the first one — that belongs to the
main checkout, along with whatever port its `.env` names, and both are held back rather than probed:
the main copy is often stopped while a branch is being set up, and a port that merely happens to be
free right now is not free to take. `PUBLIC_SITE_URL` follows the picked port and keeps the main
checkout's host, so a copy reachable from another machine stays reachable from it.

Running it again **keeps** databases the worktree already has. Replacing them is explicit:

```bash
pnpm bootstrap:worktree --refresh-databases
```

A day's work in a worktree cannot be wiped by re-running it out of habit.

This is the one place a script still writes `.env` for you, and the reason is that a worktree's
values are derived rather than chosen: the main checkout's file is the starting point, and what must
differ is replaced — the slug, the port, `PUBLIC_SITE_URL` built from that port, and
`ACCEPTANCE_BASE_URL` dropped so the suites do not aim at the main checkout.

Database credentials are not among them: `DATABASE_URL` carries over as it is. What keeps two branches
apart is the slug the database names are built from — one server, two sets of databases.

Point a worktree at a **different** server and that works too: edit `DATABASE_URL` in its `.env`
before running bootstrap. Both connections are built from their own file, so the databases are dumped
from the main checkout's server and restored onto this one, and each address is probed separately —
a server that does not answer names the file its address came from.

## The database

The panel's database section is at `/admin/database`, owner-only, through Gateway. Behind it is
[`pg-interface`](../pg-interface/README.md), this template's own interface: the tables of every
module's database, a page of rows, and adding, changing or removing one row.

It can also **add a column, and rename or drop a column it added itself** — each change written into
the project as one more migration of that module, ready to commit, so a colleague who pulls the code
gets the column with it. A column that came from a module's migration it will not touch: the module's
code names that column, and a rename would break it with the next request. Tables it does not create at
all.

`psql` is the other way in, and the one that can do what the interface will not:

```bash
psql "postgres://template:template@127.0.0.1:5432/${PROJECT_SLUG}_auth"
```

Each module works in a database of its own — `<PROJECT_SLUG>_<module>` — created on first use through
the one account in `DATABASE_URL`, which needs `CREATEDB` and opens every database on the server.

What separates the modules, then, and what does not. Separate databases still mean a query cannot reach
a neighbour's table: it would have to be a different connection, not a different table name. What is
gone is PostgreSQL refusing that connection — there are no per-module roles any more, so the module
that opens the wrong database is stopped by the check it makes when its pool opens (`Pool opened
database … expected …`) and by nothing else. That check runs before the migrations, so a mistyped
`DATABASE_URL_<MODULE>` cannot build one module's tables in another module's database.

The `template` account in the `psql` line above is the same one the modules use: it comes from
`DATABASE_URL` and is what creates the databases — which is also why it is the convenient one to poke
around with. It is also the one account every copy of the project on this machine shares, so a
careless `DROP` in the wrong database is a real possibility; the slug in the name is the only thing
telling them apart.

## The checks, and what each is for

| Script | Refuses |
| --- | --- |
| `check-dependencies.mjs` | A manifest — the root's included, because its `node_modules` is on every package's lookup path — declaring a neighbouring service, or a package that opens a door out of the process: the database driver belongs to the five modules that own a database, to `shared` and to `tests`; the server that opens a port belongs to the entry. Also an `.npmrc` setting that would hoist every package into reach |
| `check-boundaries.mjs` | A module importing another module, type-only imports included; a database pool built anywhere but the one file a module is allowed to build it in, or that file not asking which database it actually opened; **an import of `@hono/node-server`, which opens a port, anywhere but the entry**; a module reading the environment; a door that would carry code, in its source and in what it emits; a browser-facing file of `shared` importing anything but `zod` |
| `check-procedures.mjs` | A procedure that declares no `.output()`; an admin procedure that changes something without asking for a CSRF token — the builder is followed to its definition rather than trusted by its name; a router that is neither mounted nor handed to a caller factory |
| `check-migrations.mjs` | A migration file that is in a module's folder but in no list, so it would never be applied and nothing at runtime would notice; a file whose name disagrees with the version and name inside it; a version used twice or out of order; a migration written by the database section under a name that cannot be read back, which is ownership of a column lost in silence |
| `check-service-ids.mjs` | A service known to Gateway but invisible in the Admin shell, or the reverse; a grantable service that is not an admin service; the database section being public or grantable |
| `check-scripts.mjs` | A script named after a pnpm command — `pnpm up` would run pnpm's dependency update instead of starting the project |

They exist because each protects a rule that is easy to break by accident and hard to notice.

## Adding a module

1. The module under `modules/`, with its routers split by trust boundary — public, internal, admin —
   and a `src/contract.ts` re-exporting their **types** for whoever calls it.
2. The same package exporting `createApp(deps)` — or `createModule(deps)`, returning the application
   **and** the caller, if a neighbour has to reach its internal procedures. If it stores anything, it
   also carries its own `src/db/database.ts` — creating its database, applying its migrations, opening
   the pool — and its `src/db/migrations/`, one file per version listed in that folder's `index.ts` — and its name goes into the composer's `DATABASE_MODULES`, which is what gets it a
   connection string on `c.env`. That file is a copy of a neighbour's, 106 lines of it, differing only
   in the module's name — measured, not estimated. Its pool is `max: 5`, so a module with a database
   also adds five connections to what this process takes from the server's hundred.
3. Its id in `ADMIN_SERVICE_IDS` and, unless only the owner should reach it, in
   `ASSIGNABLE_SERVICE_IDS` — both in [`shared/src/vocabulary.ts`](../shared/src/vocabulary.ts).
4. Its id in Gateway's `ADMIN_SERVICES` allowlist, and — only if it should be reachable without a
   session — in `PUBLIC_SERVICES` as well; plus its entry in the Admin shell's
   [`services.ts`](../modules/admin/web/src/services.ts).
5. Its directory under `pg` in `OUTSIDE_PROCESS_PACKAGES` in
   [`scripts/workspace-rules.mjs`](../scripts/workspace-rules.mjs) if it stores anything — that is what
   lets it declare the database driver. Nothing has to be added
   to the environment: `DATABASE_URL_<MODULE>` works without being declared anywhere, because the
   composer reads it by name when it is set.
6. What the checks ask for next, and the reason this is a list rather than a sentence: `pnpm check`
   stays red until all of it is done. The name in `InternalServiceName`
   ([`shared/src/service-names.ts`](../shared/src/service-names.ts)) — `createServiceApp` is typed
   against it. The package in the **root** manifest and in
   [`tsconfig.entry.json`](../tsconfig.entry.json), because the entry imports it. An icon in the
   shell's sidebar, where the map is `Record<AdminServiceId, …>`, so a missing one is a type error
   rather than a blank space. And the two suites that spell the services out: `visibleServices` in
   Admin's tests, and the services and databases in
   [`tests/src/access.test.ts`](../tests/src/access.test.ts).

`check-service-ids.mjs` will tell you if you missed one of the three places ids live —
`ADMIN_SERVICE_IDS`, Gateway's `ADMIN_SERVICES`, the shell's `services.ts`. `ASSIGNABLE_SERVICE_IDS`
is the one it cannot tell you about: leaving a service out of it is a legitimate choice, so the
result is a service nobody but the owner can be given.

For a module's admin interface, see [the admin panel](admin-panel.md).
