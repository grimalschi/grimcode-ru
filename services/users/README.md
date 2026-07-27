# users

The product profile of a user: a display name, and whatever a product adds to it.

Users stores no passwords, no OAuth identities, no sessions and no administrator rights. It links a
profile to an Auth identity and nothing more.

## Data

Users owns the database `<PROJECT_SLUG>_users`. Migrations are in
[`src/db/migrations.ts`](src/db/migrations.ts).

`profiles.identity_id` deliberately has **no foreign key**: the identity lives in the Auth
database, which Users may never read or reference. The link is a contract, not a join.

A profile is created lazily on first access, so Auth never has to know that Users exists. The
unique index on `identity_id` makes concurrent first requests converge on the same row.

## Surfaces

| Mount | Reachable as | Callers |
| --- | --- | --- |
| `/service/users/rpc` | through Gateway, no admin check | the App, with a user session |
| `/admin/embed/service/users/rpc` | through Gateway's admin route | administrators granted Users |
| `/internal/rpc` | internal Docker network only | Auth, for the recipient locale |

### Session checks are server-side

Users owns no sessions and does not know the cookie's internal format. Every protected call asks
Auth over the internal contract. The App's route guard exists for the user flow; **this** check is
what protects the data.

### Public procedures

`getOwnProfile`, `updateOwnProfile`, `updateOwnPreferences`.

These back the App's single settings section — the part owned by Users.
Account, security and session management belong to Auth and are not duplicated here.

### Service admin

`listProfiles`, `getProfile`. Read-only: a profile belongs to the person it describes. This is the product user list; the administrator
registry is a separate thing owned by Admin and is never shown here. Mutations require the
Gateway-verified administrator context and a valid CSRF token.

The `email` field of an admin profile row is intentionally `null`: the address belongs to Auth, and
Users does not mirror it.

## Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Base connection; Users uses `<PROJECT_SLUG>_users` |
| `PROJECT_SLUG` | Database and cookie naming |

## Commands

```bash
pnpm --filter @template/users test
```
