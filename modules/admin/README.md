# Admin

Admin owns administrator roles, module grants, their audit history, the panel shell and the
database browser. Administrators sign in through [Auth](../auth/README.md).

## Integration

```ts
const admin = createModule({ env, modules: { auth: auth.internalCaller }, catalogue });
```

The instance exposes `adminFetch`, `internalCaller` and `migrate`.
[`AdminApi`](../../contracts/src/modules/admin.ts) defines the internal authorization call.
`catalogue` supplies installed modules' `{ id, admin: { title, icon, assignable? } }` descriptors;
IDs must be unique and path-safe. `assignable: false` makes a module owner-only; the default is true.
The panel's `session` procedure returns the permitted descriptors, which drive navigation and grants.
`icon` is a kebab-case ID from [Lucide](https://lucide.dev/icons/), for example `mail` or `key-round`.
The sidebar loads icons locally on demand; an unknown ID falls back to `app-window`.

| Address | Purpose |
| --- | --- |
| `/admin/rpc` | Panel tRPC API, including `database.*` |
| `/admin/csrf` | Panel mutation token |
| `/admin/module/:id` | Embedded module's screen |
| `/admin/administrators`, `/admin/audit` | Administrator management and access history |
| `/admin/database` | Database browser |

## Authorization and roles

Router calls `authorize({ sessionToken, target })` for every administrative request. Admin resolves
the Auth session and checks the administrator's enabled state, role and grants. An owner can access
every installed module; an ordinary administrator can access granted, assignable modules.
Administrators, Admin audit and the database browser require the owner role in their server procedures.
Role and grant changes take effect on the next request.

Authorization results and denial reasons are defined in
[`AdminApi`](../../contracts/src/modules/admin.ts); [Router](../router/README.md#administrative-authorization)
turns them into HTTP responses. Module procedures validate Router's
[administrator headers](../router/README.md#trusted-administrator-headers) and enforce any finer permissions.

### First owner

The first administrative request with a valid session initializes an empty registry from Auth's
earliest registered identity. Ownership follows registration order, even if another user opens the
panel first. A transaction and unique bootstrap record make concurrent initialization produce one
owner and one audit entry. With no registered identities, the panel asks for registration.

### Managing access and preserving an owner

Owners add registered users by email, assign roles and module grants, and enable or disable
administrators. Each change is audited; disabling keeps the administrator's history.

Administrator additions, role changes and identity blocking share a registry lock. Inside it, Admin rechecks the actor's
session and role and asks Auth which remaining owners can sign in. This preserves an accessible
owner when requests overlap. The “Блокировка аккаунтов” dialog searches all Auth identities;
blocking revokes their sessions and recovery tokens through Auth's internal API.

The administrator list and its email search resolve current addresses through Auth.

### CSRF

Each administrative surface with mutations has its own `csrfCookieName`. Its CSRF endpoint returns `{ token }`,
reuses a valid existing token, sets a readable `Path=/; SameSite=Lax` cookie and sends
`Cache-Control: no-store`. The browser repeats
the token in `x-csrf-token`; mutations compare that header with the same surface's cookie using a
length check and constant-time comparison. Every new mutation needs this guard.

Admin's procedure builders combine these checks: `adminProcedure` validates administrator context,
`ownerProcedure` also requires owner, and their `*Mutation` variants additionally require CSRF.
Panel logout revokes the session through Auth before clearing the cookie, following the
[session cookie protocol](../auth/README.md#session-cookies).

## Embedded interfaces

The shell owns navigation and theme preference. Links to Site and App open new tabs and use muted
styling to distinguish them from navigation within Admin. The mobile menu opens and closes at the same
screen position, so the user can tap twice without moving their finger. Each embedded module owns its interface.
For example, `/admin/module/email#/templates/123` opens the frame at
`/admin/embed/module/email/templates/123`.

### Frame protocol

Both ends send `postMessage` to their exact origin and check `event.origin` and `event.source`.
The shell accepts messages from its current iframe; the module accepts messages from its parent.

| Direction | Message object |
| --- | --- |
| Shell → frame | `{ type: 'template.admin.theme', theme: 'light' \| 'dark' \| 'system' }` |
| Shell → frame | `{ type: 'template.admin.navigate', path: string }` |
| Frame → shell | `{ type: 'template.admin.ready' }` |
| Frame → shell | `{ type: 'template.admin.path', path: string }` |

Paths are module-relative, start with `/` and collapse repeated slashes. A child reports its path
to update the outer URL. The shell sends `navigate` when the requested path changes, and sends the
theme on load, readiness and preference changes. Frame load only synchronizes the theme: replaying
the outer path could undo navigation that started inside the frame.

Embedded modules follow the shell's theme; directly opened modules use their own preference.
`system` follows `prefers-color-scheme`, with the resolved `light` or `dark` value in `data-theme`.
The shell implementation is in [`web/src/frame/`](web/src/frame).

### Connecting an interface

Set the module SPA's Vite `base` and router `basepath` to `/admin/embed/module/<id>/`.
Serve its assets and RPC through `adminFetch`; add a CSRF endpoint for mutations. Return `admin`
metadata and connect both through composition. The browser uses its own server's router type and administrative RPC
prefix. Implement the frame protocol and verify direct links, navigation and access through Router.

For an Admin-owned section, register its route in [`main.tsx`](web/src/main.tsx) and navigation in
[`app-sidebar.tsx`](web/src/components/app-sidebar.tsx). Owner-only sections require a server owner
check for every procedure as well as the browser guard.

## Database browser

`/admin/database` reads and edits rows across user schemas through Admin's PostgreSQL pool.
`database.schemas`, `tables` and `rows` discover tables and load filtered, sorted pages;
`insert`, `update` and `delete` modify rows. View settings are stored in the page URL.

Every procedure requires owner; mutations also require Admin's CSRF token. Identifiers are checked
against PostgreSQL's catalogue, values are SQL parameters, and updates and deletes require the
complete primary key. JSON values travel as text to preserve numeric precision and distinguish
JSON `null` from SQL NULL. PostgreSQL arrays also travel as their original text. System schemas and `schema_migrations` are excluded at the API boundary.

## Configuration and data

[`AdminEnv`](src/env.ts) receives `databaseUrl`, `sessionCookieName`, `csrfCookieName` and
`publicOrigin`. Session settings must match Auth so logout clears the same cookie.

Schema `admin` stores `administrators`, `administrator_grants` and `admin_audit`.
Administrator records refer to Auth identity IDs; identity lookups use Auth's API. Schema changes
belong in [`src/db/migrations/`](src/db/migrations), following the
[migration instructions](../../docs/development.md#migrations).

Run `pnpm --filter @template/admin test` for module checks. See
[development guide](../../docs/development.md#checks) for application and browser checks.
