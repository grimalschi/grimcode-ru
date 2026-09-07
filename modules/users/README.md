# users

The product profile of a user: a display name, and whatever a product adds to it.

Users stores no passwords, no OAuth identities, no sessions and no administrator rights. It links a
profile to an Auth identity and nothing more.

## Data

Users owns the database `<PROJECT_SLUG>_users`, which it creates and opens itself. Migrations are
in [`src/db/migrations/`](src/db/migrations) and are applied by this module itself, on the first
request that opens its pool — as is creating the database if it is missing.

`profiles.identity_id` deliberately has **no foreign key**: the identity lives in the Auth
database, which Users may never read or reference. The link is a contract, not a join.

A profile is created lazily on first access, so Auth never has to know that Users exists. The
unique index on `identity_id` makes concurrent first requests converge on the same row.

## Surfaces

| Mount | Reachable as | Callers |
| --- | --- | --- |
| `/service/users/rpc` | through Gateway, no admin check | the App, with a user session |
| `/admin/embed/service/users/rpc` | through Gateway's admin route | administrators granted Users |

### What a neighbour may see of this module

A tRPC client is typed from the server's router, so the type has to cross the module boundary. It
crosses through one named door: `@template/users/contract` resolves to
[`src/contract.ts`](src/contract.ts), which re-exports the two router types and the two profile
shapes the bundles render — `UserProfile` and `AdminUserProfile` — and nothing else, while the bare
`@template/users` resolves to `createApp` and the `UsersEnv` type and nothing besides. Two bundles use it:
the App's, for the public surface, and this module's own admin panel, which takes the same route
rather than reaching into `src` by a relative path.

That door is not an agreement about behaviour: it decides which files are visible, not what ends up
in the type. What keeps the type honest is the `.output()` schema every procedure declares and the
`satisfies` line beside each router, which refuses to compile when the router holds a name the
surface is not allowed to hold — see [shared/README.md](../../shared/README.md) for how a procedure is
added.

### Session checks are server-side

Users owns no sessions and does not know the cookie's internal format. Every protected call asks
Auth over the internal contract. The App's route guard exists for the user flow; **this** check is
what protects the data.

### Public procedures

`getOwnProfile`, `updateOwnProfile`.

These back the App's single settings section — the part owned by Users.
Account, security and session management belong to Auth and are not duplicated here.

Preferences — a language, a theme, a time zone — are deliberately absent. Only the product knows what
shape they take, and a template that guessed would make every project delete the guess before adding
its own; a product adds them together with the procedure that changes them.

### Service admin

`listProfiles`, `getProfile`. Read-only, because a profile belongs to the person it describes. This is
the product user list; the administrator registry is a separate thing owned by Admin and is never
shown here.

Read-only also means there is no admin mutation here and no builder that checks a CSRF token. The
browser client already sends one on mutations, so adding a changing procedure needs the server half
with it — a builder that calls `requireCsrf` — or the token travels and nothing verifies it.

The `email` of an admin profile row is not stored by Users: the address belongs to Auth, and it is
filled in per request, one call for the whole page. It is `null` when Auth no longer has that
identity, which is how a profile left behind by a deleted account shows up rather than looking like
an ordinary one — and also, for the whole page at once, when the call to Auth failed. The page is
worth showing without addresses, so that failure is caught rather than raised, and the line it writes
(`sign-in addresses could not be read from auth`) is what tells the two cases apart.

## Environment

Nothing in this module reads it: the composer reads these and hands over what belongs to this
module on `c.env`. What follows is what a deployment sets on its behalf.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Base connection; Users uses `<PROJECT_SLUG>_users` |
| `PROJECT_SLUG` | Database and cookie naming |

## Commands

```bash
pnpm --filter @template/users test
```
