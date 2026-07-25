# shared

Common technical utilities and the admin UI foundation.

Business logic and per-service repositories never live here — those belong to the owning service.
A service may import its own folder, `contracts/`, `shared/` and external packages, and nothing
else.

## Runtime modules

| Module | Purpose |
| --- | --- |
| `env.ts` | Typed environment access, project slug, per-service database URLs and cookie names |
| `service-urls.ts` | Pinned internal container ports and internal service base URLs |
| `logger.ts` | JSON-line logger with request-scoped child loggers |
| `crypto.ts` | Ids, single-use tokens, scrypt password hashing, constant-time comparison |
| `http/cookies.ts` | Cookie parsing and serialization, including the expired logout cookie |
| `http/admin-context.ts` | The verified administrator context headers and their strip/apply/read helpers |
| `http/csrf.ts` | Double-submit CSRF token issuing and validation |
| `http/service-app.ts` | Shared Hono app: request ids, access log, health endpoint, fail-closed 503 |
| `orpc/handler.ts` | Mounting an oRPC router on a path prefix, merging `set-cookie` from procedures |
| `orpc/client.ts` | Typed oRPC client factory and `ServiceUnavailableError` |
| `db/pool.ts` | One PostgreSQL pool per service database, transactions, startup wait |
| `db/migrator.ts` | Versioned migrations with recorded versions, checksums and advisory locks |
| `theme.ts` | The same-origin `postMessage` protocol between Admin shell and service iframes |

### Admin context is a trust boundary

`ADMIN_CONTEXT_HEADERS` are the headers Gateway writes after Admin allowed a request. Gateway
deletes every one of them from the incoming request first, so a browser can never forge them. A
service treats a missing or malformed context as a denial.

### Migrations

`runMigrations` records each applied version with a checksum. A fresh database is built from
version 1 upwards, an existing database only receives missing versions, and running the same set
again changes nothing. Editing an already released migration is an error — add a new version.

## Admin UI

| File | Purpose |
| --- | --- |
| `ui/tokens.css` | Semantic design tokens for light, dark and system |
| `ui/admin-kit.css` | Non-React admin components for surfaces where shadcn/ui cannot be used |

The token values match `docker/adminer/adminer.css`, so Adminer — which keeps its own isolated
stylesheet — still reads as part of the same system. `light` and `dark` are explicit through
`[data-theme]`; `system` is the *absence* of the attribute, which is exactly what the shell's theme
bridge sends.

The kit exists for server-rendered or third-party admin surfaces only. React admins use the real
checked-in shadcn source components from the central Admin and share nothing but the tokens.

## Commands

```bash
pnpm --filter @template/shared build
```

```bash
pnpm --filter @template/shared test
```
