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

Gateway calls `admin.authorize` on **every** `/admin/**` request — HTML, API and assets alike. It
passes the session cookie and the **target**: the panel itself, one service's admin, or the database
area. Gateway works the target out from the URL and knows nothing about who may reach it.

```
no session                        → denied: no-session
session Auth no longer knows      → denied: no-session
registry empty, Auth empty        → awaiting-first-user
not in the registry               → denied: not-an-administrator
disabled                          → denied: disabled
target is the panel               → allowed for any enabled administrator
target is the database, not owner → denied: owner-only
owner                             → allowed
admin with the grant              → allowed
admin without the grant           → denied: no-grant
```

Gateway computes nothing itself, keeps no copy of the rights and caches no result, which is why a
changed role or grant takes effect on the very next request.

Hiding a menu entry is interface only. A direct URL passes exactly the same check.

## First owner

At the first authorized `/admin` request Admin checks its registry. If it is empty, it asks Auth
for the earliest registered identity and atomically promotes it to owner.

Ownership follows **registration order in Auth**, not who opened the admin panel first. If a
different user opens it, the first Auth user still becomes owner and the current request is
refused.

- If Auth has no users at all, no owner is created and the state `awaiting-first-user` is returned.
- The insert is conditional, and the partial unique index `administrators_single_bootstrap_idx`
  makes two concurrent requests converge on one owner.
- Only the request that really inserted the row writes the bootstrap audit entry.
- Once any administrator exists, the bootstrap is no longer attempted.

## Managing administrators

An owner adds an **already registered** user by email, enables or disables them, changes their role
and grants access to services. The product user list from Users is never shown here.

- Administrators are never deleted. Disabling keeps the history.
- The last active owner can neither be demoted nor disabled. The check runs inside the transaction
  that performs the change, so two simultaneous requests cannot both believe another owner remains.
- An owner may change their own role or disable themselves only while another active owner exists.
- Every change is written to the audit.

Owner-only mutations require both the Gateway-verified administrator context and a valid CSRF
token.

## Logout

`logout` is a server-side Auth operation: Auth invalidates the session row in its own database and
answers with the cookie-clearing header, which is forwarded to the browser. Deleting the cookie in
client JavaScript alone would leave a usable session behind.

## Data

Database `<PROJECT_SLUG>_admin`. Migrations are in [`src/db/migrations.ts`](src/db/migrations.ts).

`administrators.user_id` refers to an Auth identity and carries **no foreign key**: identities live
in the Auth database, which Admin may never read or reference.

## Surfaces

| Mount | Reachable as | Callers |
| --- | --- | --- |
| `/internal/rpc` | internal Docker network only | Gateway, for `authorize` |
| `/admin/rpc` | through Gateway's admin route | the central Admin shell |
| `/admin/**` | through Gateway's admin route | the built shell assets |

`/admin/embed/**` is proxied by Gateway to the embedded applications rather than to this service:
`services/:id` to that service's admin, `database` to the database browser. See
[the admin panel](../../docs/admin-panel.md).

## Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Base connection; Admin uses `<PROJECT_SLUG>_admin` |
| `PROJECT_SLUG` | Database and cookie naming |

## Commands

```bash
pnpm --filter @template/admin test
```
