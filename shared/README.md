# shared

Common technical utilities every module is allowed to use.

Business logic and per-module repositories never live here — those belong to the owning module.
A module may import its own folder, `shared/`, a neighbour's declared `@template/<name>/contract`, and
external packages — except the ones that open a door out of the process. There are two of those, each
with its own list of who may hold it: the database driver belongs to this package, the five modules
that own a database, the acceptance tests and the panel's database interface; the server that opens a
port belongs to the program's entry, and the import that opens one may be written nowhere else.

## Runtime modules

| Module | Purpose |
| --- | --- |
| `env.ts` | Typed environment access, project slug, the public origin, cookie names |
| `service-names.ts` | The module-name union `createServiceApp` takes. Names only: there is no address anywhere in the process |
| `crypto.ts` | Ids, single-use tokens, scrypt password hashing, constant-time comparison |
| `rate-limit.ts` | Fixed-window attempt counter, in memory on purpose — one account's password, not volumetric limits |
| `http/cookies.ts` | Cookie parsing and serialization, including the expired logout cookie |
| `http/admin-context.ts` | The verified administrator context headers and their strip/apply/read helpers |
| `http/csrf.ts` | Double-submit CSRF token issuing and validation |
| `http/service-app.ts` | Shared Hono app: request ids and `/healthz`. Opening a port is not here — the program does that, so a module cannot |
| `http/spa.ts` | Serving a built SPA with deep-link fallback, refusing any path that would escape the build directory, and the endpoint that issues its CSRF token |
| `rpc.ts` | What a call to a neighbour needs whichever library carries it: `FetchLike`, the deadline and `withDeadlineOn`, which puts it on every procedure of a caller, `ServiceUnavailableError` |
| `trpc/mount.ts` | Mounting a tRPC router on a path prefix, merging `set-cookie` from procedures |
| `trpc/builders.ts` | The context every procedure has, and the two guards admin surfaces are built from |
| `db/pool.ts` | Transactions and the startup wait a module uses around the pool it opened itself; the pool is built in the module, not here |
| `db/migrator.ts` | Versioned migrations with recorded versions, checksums and advisory locks |
| `db/migration-file.ts` | Writing one into a module's folder, for the change of shape the admin panel makes |
| `theme.ts` | The same-origin `postMessage` protocol between Admin shell and service iframes |
| `vocabulary.ts` | The words the whole template shares: schema primitives, service ids, admin roles, the verified admin context |
| `index.ts` | The barrel, and what it leaves out: `vocabulary.ts` and `theme.ts` have subpaths of their own — `./vocabulary` and `./browser` — so neither arrives by importing `@template/shared`, and a browser bundle reaching for the theme never pulls the server's toolbox with it |

### Admin context is a trust boundary

`ADMIN_CONTEXT_HEADERS` are the headers Gateway writes after Admin allowed a request. Gateway
deletes every one of them from the incoming request first, so a browser can never forge them. A
service treats a missing or malformed context as a denial.

### Migrations

`runMigrations` records each applied version with a checksum. A fresh database is built from
version 1 upwards, an existing database only receives missing versions, and running the same set
again changes nothing. Editing an already released migration is an error — add a new version.

A module keeps them in `src/db/migrations/`, one file per version, listed in that folder's `index.ts`.
The checksum is taken from the text of the statement, indentation included, so a released file is left
alone entirely — reindenting one is enough to stop the module against a database that has already run
it. One file each is what keeps that promise easy to keep, and `check-migrations` refuses a file that
no list mentions.

## Adding a procedure

Two places in the same file, and the second is the one that is easy to skip.

1. **Write the procedure in the module's router**, schemas and all:

   ```ts
   revokeSession: adminMutation
     .input(z.object({ sessionId: idSchema }))
     .output(z.object({ ok: z.literal(true) }))
     .mutation(async ({ input, ctx }) => { … }),
   ```

   A shape used by more than one procedure goes in the module's own `schemas.ts`; a shape a
   neighbour or a browser needs is named there too and re-exported from `src/contract.ts` as a
   **type** — that file compiles to `export {}` and a Zod object is a value.

2. **Add the name to the router's list**, the `satisfies` line at the closing brace:

   ```ts
   type AdminName = 'listIdentities' | 'getIdentity' | 'revokeSession';
   ```

   Forget it and `tsc` fails, naming the procedure:
   `'revokeSession' does not exist in type 'Record<AdminName, unknown>'`.

   That is the point of the list — it is what stops an admin procedure from being written into a
   public router, where anyone could call it — and it is the compiler that enforces it, not a script
   of ours. `check-procedures.mjs` never reads the names; it would count the stray procedure and pass.

### Two things here are not the tRPC from the documentation

**`.output()` is written on every procedure.** The tRPC docs call output validation optional —
"validating outputs is not always as important as defining inputs, since tRPC gives you automatic
type-safety by inferring the return type of your procedures" — and list not returning more data than
necessary as one reason to do it anyway. In this template that reason applies to all of them: every
procedure hands data from a database across a module boundary. Without the schema, whatever the
resolver returns is what ships, and TypeScript will not stop it — excess property checks apply to
object literals, not to the row you read from a repository.

**Each router is pinned to a list of names.** Stock tRPC has no such thing, because it has no
contract to be complete against. The list is a plain type and `satisfies` is a plain keyword; what
it buys is that a procedure cannot land on the wrong surface unnoticed.

Both are deliberate, and both cost a line — but only the first is what `check-procedures.mjs` looks
for. That script refuses three things, and a router it turns down is failing one of them rather than
hitting a bug: a procedure with no `.output()`; an admin procedure that changes something while built
on a builder that does not pipe `requireCsrf` in; and a router that is neither mounted nor handed to
a caller factory, because a surface reached in a way it cannot see is one it cannot judge.

## No shared UI

There is no shared stylesheet and no shared component — nothing in this package renders anything.
Each admin vendors its own shadcn source and its own copy of the tokens: copies of the same values
on purpose, so one service restyling itself cannot restyle its neighbours.

What is shared is the *convention*: `light` and `dark` are explicit through `[data-theme]`, and
`system` is the absence of the attribute, which is exactly what the shell's theme bridge sends. The
one line of code behind it is `applyTheme` in `theme.ts`, and anything the panel embeds has to obey
the same rule whether it imports that line or reimplements it.

## Commands

```bash
pnpm --filter @template/shared build
```

```bash
pnpm --filter @template/shared test
```
