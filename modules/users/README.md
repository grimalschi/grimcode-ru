# Users

Owns the product profile: currently a display name linked to an Auth identity by `identity_id`.
Add product-specific fields here as the application grows.

Profiles live in `users.profiles` and are created on first access. The unique identity key makes
concurrent first requests use the same profile, keeping registration independent of profile creation.

## API

[`createModule`](src/index.ts) receives [`UsersEnv`](src/env.ts) and `modules.auth`, and returns
`publicFetch`, `adminFetch`, the Admin description and `migrate()`.

| Entry | Procedures |
| --- | --- |
| `/module/users/rpc` | `getOwnProfile`, `updateOwnProfile` for the current user |
| `/admin/embed/module/users/rpc` | `listProfiles`, `getProfile` for administrators granted Users |

Every public call resolves the session through Auth before reading or changing a profile.
App uses the [`UsersPublicRouter`](../../contracts/src/modules/users.ts) contract.

The administrative list gets sign-in addresses from Auth in one lookup per page. An absent identity
or a failed lookup produces `email: null`; the profiles remain available in either case.

`env` supplies `databaseUrl` and `sessionCookieName`.
The module's [migrations](src/db/migrations) define its schema; follow the
[migration instructions](../../docs/development.md#migrations) when changing it.
