# Development

For the first checkout, follow the [quick start](../README.md#первый-запуск).
[`.env.example`](../.env.example) documents application settings; module READMEs describe their defaults.

## Worktrees

Prepare the main checkout's `.env` and database first. Each worktree gets its own database and port:

```bash
git worktree add ../project-feature -b codex/feature
cd ../project-feature
pnpm install
pnpm bootstrap:worktree
pnpm dev
```

Bootstrap uses the main checkout's configuration, generates a project slug, selects a free port and
copies the whole database, including all module schemas. It requires `psql`, `pg_dump` and a database
account with `CREATEDB`. The first port in `PORT_RANGE_START`–`PORT_RANGE_END` and the main checkout's
configured port are reserved for main. Ports assigned in other worktrees are also reserved.

Existing worktree settings take precedence. To use a particular database or another PostgreSQL
server, set the worktree's `DATABASE_URL` before bootstrap. Bootstrap preserves that connection's
options and requires a database name different from main, including on another server. It clears `ACCEPTANCE_BASE_URL`
so tests default to the worktree's port.

Repeated bootstrap keeps the existing database. To replace its data with a new copy of main:

```bash
pnpm bootstrap:worktree --refresh-database
```

The source dump completes before replacement starts. Stop the worktree application first; this
command replaces its database and terminates connections to it.

## Running and configuration

`pnpm dev` builds the project and starts the application on `PORT`. Restart it after code changes
to rebuild. For frontend hot reload, start its `pnpm --filter @template/<module> dev:web`
alongside this process and open the Vite URL. Its API proxy uses the root `.env` PORT; cookies
require the same hostname in both URLs. `PUBLIC_SITE_URL` must be the origin used by the browser: it also supplies authentication
links and cookie settings.

`PROJECT_SLUG` prefixes cookies and supplies the default database name for new worktrees. Use a
lowercase letter followed by lowercase letters, digits or underscores, up to 63 characters.
An existing database is selected by `DATABASE_URL`, independently of the slug.

For deployment, build with `pnpm build`, supply the settings from `.env.example` through the platform
and run `pnpm start` (`NODE_ENV=production`). Provision the database beforehand; modules create their schemas at
startup. The platform routes external traffic to the application's `PORT`.

## Checks

| Command | Use |
| --- | --- |
| `pnpm --filter @template/<module> test` | Run that module's tests, if it defines a test script |
| `pnpm --filter @template/admin test:database` | [Admin's PostgreSQL editing tests](../modules/admin/README.md#tests); pass `DATABASE_URL` in the process environment |
| `pnpm lint` | Check code and module boundaries |
| `pnpm typecheck` | Check TypeScript and module contracts |
| `pnpm check` | Lint, types, unit tests and production build |
| `pnpm test:acceptance` | HTTP integration tests against a running application |
| `pnpm test:browser` | Browser tests against a running application |

Choose checks that exercise the change. Run `pnpm check` before handing over code changes; for
application flows or UI, also use the relevant [application tests](../tests/README.md). Documentation
changes need working links and instructions consistent with the code.

## Adding a module

1. Create its package under `modules/` and implement the
   [module contract](../contracts/README.md#module-instance). Declare exchanged APIs in `contracts/`.
2. Add the package to root `package.json` and `tsconfig.entry.json`. Create it in `index.ts` after its
   dependencies, passing their callers through `modules`.
3. Add the instance before Admin and Router derive their metadata and handler maps. An embedded
   screen supplies `admin` and `adminFetch`; follow [Admin's integration guide](../modules/admin/README.md#connecting-an-interface).
4. For storage, add a local pool and migrations under `src/db/`. Use the module's fixed schema and
   include its pool size in the total PostgreSQL connection budget.
5. Document the module's API and settings in its README; add installation settings to `.env.example`.

## Changing an API

Implement procedures with local `.input()` and `.output()` validation. For an API consumed by
another module, update the [contract and its type checks](../contracts/README.md) along with the provider.
Test changed behavior and access rules, including CSRF refusal for administrative mutations.

Protocol definitions belong to their owners: [HTTP context](../contracts/README.md#http-context),
[Auth cookies](../modules/auth/README.md#session-cookies), and
[Admin frames](../modules/admin/README.md#frame-protocol) and [CSRF](../modules/admin/README.md#csrf).
A protocol change needs corresponding changes in its consumers.

## Migrations

The template starts from an empty database. Each module's `001` migration defines its current
initial schema. When changing the template, update that schema and verify it on a new database.

For an application already deployed from the template:

1. Add the next numbered file to the module's `src/db/migrations/`, exporting
   `const migration = { version, name, sql }`.
2. Import it into that folder's `index.ts` and append it to `migrations` in version order.
3. Run the module's migration tests and start the application on your development database.

Keep applied migrations unchanged and make corrections in a new version. The module records versions
in its own `schema_migrations` table, with a SHA-256 checksum of UTF-8 `sql.trim()`.

Startup awaits each module's `migrate()` before listening. Each migration runs in a transaction;
a schema-specific advisory lock coordinates concurrent applications. On failure, startup stops and
previously committed versions remain applied. Resolve the cause of the failure, then restart.
