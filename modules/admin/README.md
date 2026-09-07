# admin

Administrator rights and the central admin panel.

Admin owns the registry of administrators, their roles, their access to services and the audit of
every change. There is no separate admin registration, no admin passwords and no admin sessions:
an administrator signs in with the ordinary identity and session from Auth.

## Roles

| Role | Sees |
| --- | --- |
| `owner` | every admin service, and manages administrators |
| `admin` | only the services explicitly granted to them |

**The database area is always owner-only.** It is not a service, so no grant can name it; it reads
every service's data at once, which is the whole reason it belongs to the owner alone.

## The single authorization method

Gateway calls `admin.authorize` on every `/admin/**` request it is willing to route — HTML, API and
assets alike. It passes the session cookie and the **target**: the panel itself, one service's admin,
or the database area. Gateway works the target out from the URL and knows nothing about who may reach
it.

A path that names nothing real — an unknown service, or `/admin/embed/` followed by neither `service`
nor `database` — is Gateway's own 404, and Admin is never asked.

```
target names an unknown service   → denied: unknown-service
no session, registry empty,
  and Auth has nobody registered  → awaiting-first-user
no session otherwise              → denied: no-session
session Auth no longer knows      → denied: no-session
not in the registry               → denied: not-an-administrator
disabled                          → denied: disabled
target is the panel               → allowed for any enabled administrator
target is the database, not owner → denied: owner-only
owner                             → allowed
admin with the grant              → allowed
admin without the grant           → denied: no-grant
```

The first line is checked before the session, so a name that is not an admin service is refused
whoever asks — though Gateway 404s such a path before asking, which makes that branch a guard against
a caller that is not Gateway.

The second is the one case where a request without a session is answered with something other than a
refusal, and it is why the state is reachable at all: a session means an identity, and an identity
means Auth has a first one to promote. Only an empty registry is worth asking Auth about, so a
running installation settles it on the cheap question and never makes the call.

Gateway computes nothing itself, keeps no copy of the rights and caches no result, which is why a
changed role or grant takes effect on the very next request.

Hiding a menu entry is interface only. A direct URL passes exactly the same check.

## First owner

At the first `/admin` request carrying a session Admin checks its registry. If it is empty, it asks
Auth for the earliest registered identity and atomically promotes it to owner.

Ownership follows **registration order in Auth**, not who opened the admin panel first. If a
different user opens it, the first Auth user still becomes owner and the current request is
refused.

- If Auth has no users at all there is nobody to promote, and the visitor — who cannot have a session
  either — is told so instead of being refused.
- The insert is conditional, and the partial unique index `administrators_single_bootstrap_idx`
  makes two concurrent requests converge on one owner.
- Only the request that really inserted the row writes the bootstrap audit entry.
- Once any administrator exists, the bootstrap is no longer attempted.

## Managing administrators

An owner adds an **already registered** user by email, enables or disables them, changes their role
and grants access to services. The product user list from Users is never shown here.

- Administrators are never deleted. Disabling keeps the history.
- The last owner who can still enter can neither be demoted nor disabled. Being blocked in Auth is
  part of that: an owner enabled here but blocked there cannot sign in, so Admin asks Auth which of
  the remaining owners are blocked before counting them. The count runs inside the transaction that
  performs the change, so two simultaneous requests cannot both believe another owner remains.
- An owner may change their own role or disable themselves only while another active owner exists.
- Every change is written to the audit.

Owner-only mutations require both the Gateway-verified administrator context and a valid CSRF
token.

## Logout

`logout` is a server-side Auth operation: Admin calls `revokeSessionByToken` on Auth's internal
surface, Auth invalidates the session row in its own database, and Admin clears the cookie on the
response it is already answering with — `expiredSessionCookie` from `shared`, the same attributes
Auth uses, because a cookie cleared with a different `Secure` or `Path` is a cookie the browser
keeps.

The order is the whole of it. Deleting the cookie in client JavaScript alone, or before the row is
invalidated, would leave a usable session behind; a failed call therefore reaches the panel as an
error rather than as a clean sign-out.

## Data

Database `<PROJECT_SLUG>_admin`, created and opened by this module itself and touched by no other
module. Migrations are in [`src/db/migrations/`](src/db/migrations) and are applied by this module
itself, on the first request that opens its pool — as is creating the database if it is missing.

`administrators.user_id` refers to an Auth identity and carries **no foreign key**: identities live
in the Auth database, which Admin may never read or reference.

## Surfaces

| Mount | Reachable as | Callers |
| --- | --- | --- |
| *not mounted* | the internal procedures are called directly, in-process | Gateway, for `authorize` |
| `/admin/rpc` | through Gateway's admin route | the central Admin shell |
| `/admin/csrf` | through Gateway's admin route | the shell, before every mutation |
| `/admin/**` | through Gateway's admin route | the built shell assets |

`/admin/embed/**` is proxied by Gateway to the embedded applications rather than to this service:
`service/:name` to that service's admin, `database` to the database browser. See
[the admin panel](../../docs/admin-panel.md).

### Who may do what, and where that is written

The panel's procedures are built on four builders rather than four guard calls, and the choice of
builder **is** the rule:

| Builder | Verifies | Used by |
| --- | --- | --- |
| `adminProcedure` | a verified administrator context | `session` |
| `adminMutation` | that, plus the panel's CSRF token | `logout` |
| `ownerProcedure` | that, plus the owner role | `listAdministrators`, `searchUsers`, `listAudit` |
| `ownerMutation` | all three | `addAdministrator`, `updateAdministrator` |

Two axes and not one — administrator against owner, read against change — which is why this module
has four while the others have at most two. The owner half stays here and is not lifted into
`shared`: Admin is the only module with enough owner-only procedures for a builder to pay for itself.
Auth has exactly one — blocking an identity — and guards it inside that mutation's body.

### What a neighbour may see of this module

A tRPC client is typed from the server's router, so the type has to cross the module boundary. It
crosses through one named door: `@template/admin/contract` resolves to
[`src/contract.ts`](src/contract.ts), which re-exports the panel's router type, the caller Gateway
asks through, and `AuthorizationResult` — the shape of the decision Gateway acts on — and nothing else,
while the bare `@template/admin` resolves to `createModule` and the `AdminEnv` type and nothing besides. It
matters more here than anywhere else — this module *is* the registry of who may do what, and the
rights, the last-owner rule and the audit log all live behind `repository.ts`, which no specifier
reaches.

That door is not an agreement about behaviour: it decides which files are visible, not what ends up
in the type. What keeps the type honest is the `.output()` schema every procedure declares and the
`satisfies` line beside each router, which refuses to compile when the router holds a name the
surface is not allowed to hold — see [shared/README.md](../../shared/README.md) for how a procedure is added.

Two callers use that door: Gateway for `authorize` on every `/admin/**` request, and the panel's own
browser bundle for the surface above.

## Environment

Nothing in this module reads it: the composer reads these and hands over what belongs to this
module on `c.env`. What follows is what a deployment sets on its behalf.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Base connection; Admin uses `<PROJECT_SLUG>_admin` |
| `PROJECT_SLUG` | Database and cookie naming |
| `PUBLIC_SITE_URL` | Decides `Secure` on the cookie `logout` clears — it has to match what Auth set |

## Commands

```bash
pnpm --filter @template/admin test
pnpm --filter @template/admin dev:web   # vite dev server for the shell
```
