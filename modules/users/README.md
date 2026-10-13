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
| `/admin/embed/module/users/rpc` | `listProfiles`, `getProfile`, `viewer` for administrators granted Users; `setBlocked` for the owner |

Every public call resolves the session through Auth before reading or changing a profile.
Web uses the [`UsersPublicRouter`](../../contracts/src/modules/users.ts) contract.

The administrative list gets sign-in addresses from Auth in one lookup per page, and with them
whether the account is blocked and whether the panel protects it from blocking. An absent identity
or a failed lookup produces `email: null`; the profiles remain available in either case.

### Blocking from the profile list

The owner blocks and unblocks accounts here, in the list of people (the owner's choice, 13 October
2026). `setBlocked` is the module's one changing admin call: owner only, with this module's own CSRF
token (`/admin/embed/module/users/csrf`, cookie `csrfCookieName`), never for the owner's own
account; it asks Auth's `setIdentityBlocked` with the verified actor, and Auth records the event.
Who may be blocked is Auth's question: the panel's owners are protected there, so the screen offers
no button for them (the row says to take the role away first) and passes Auth's refusal on if one
arrives anyway. Blocking asks for a confirmation; unblocking does not. An account without a profile
— registered, never entered the product — is not listed here and so cannot be blocked from here;
that is accepted.
Router supplies the verified [administrator context](../../contracts/README.md#http-context) through
`adminFetch(request, adminContext)`. Hono bindings carry the context and module settings for each
request. Administrative procedures require this context; HTTP headers cannot supply it. Public
requests continue to resolve their own session through Auth.

`env` supplies `databaseUrl`, `sessionCookieName` and `csrfCookieName`.
The module's [migrations](src/db/migrations) define its schema; follow the
[migration instructions](../../docs/development.md#migrations) when changing it.
