# auth

Minimal user identity, sign-in methods, sessions, email verification, account recovery and the
security flows around them.

Auth does **not** own the product profile (that is Users) or administrator rights (that is Admin).
Even though its main table is called `identities`, these are identity users, not product profiles.

## Data

Auth owns the database `<PROJECT_SLUG>_auth` and no other. Versioned migrations live in
[`src/db/migrations.ts`](src/db/migrations.ts).

| Table | Contents |
| --- | --- |
| `identities` | email, password hash, verification and blocking state, registration `sequence` |
| `sessions` | one row per session, storing only the **hash** of the session token |
| `auth_tokens` | single-use time-limited tokens for verification, recovery and email change |
| `auth_audit` | every security-relevant action, including who performed it |

Secret tokens are never stored in readable form. Nobody — including an owner — can read a
recovery token out of the database.

`identities.sequence` gives registration a deterministic order. Admin relies on it to decide who
the very first registered user is when it bootstraps the first owner.

## Surfaces

| Mount | Reachable as | Who may call it |
| --- | --- | --- |
| `/service/auth/rpc` | through Gateway, no admin check | anyone — Auth secures these itself |
| `/admin/embed/service/auth/rpc` | through Gateway's admin route | administrators with a grant on Auth |
| `/internal/rpc` | internal Docker network only | other services |

### Public flows

`register`, `login`, `logout`, `currentSession`, `listOwnSessions`, `revokeOwnSessions`,
`requestPasswordReset`, `resetPassword`, `changePassword`, `verifyEmail`, `resendOwnVerification`,
`requestEmailChange`, `confirmEmailChange`.

Security properties worth keeping when the template is extended:

- **Recovery does not reveal whether an address exists.** `requestPasswordReset` always answers
  `ok`. `register` and `requestEmailChange` do not confirm that an address is taken either.
- **Login is not an existence oracle.** When no identity matches, a fixed dummy hash is still
  verified so both branches take comparable time.
- **Links work exactly once.** Tokens are consumed in a single atomic statement, so a double click
  cannot use one twice, and issuing a new token of the same purpose invalidates the previous one.
- **Changing a password ends every session**, including one an attacker may be holding.
- **Logout is a server-side operation.** The session row is invalidated first and the HttpOnly
  cookie is cleared afterwards. Deleting the cookie alone would leave a usable session behind.
- Public procedures are JSON-only oRPC calls on a `SameSite=Lax` cookie, so a cross-site form
  cannot invoke them.

### Internal surface

`resolveSession`, `getFirstIdentity`, `getIdentityById`, `getIdentityByEmail`. Admin depends on
these to resolve the current user and to bootstrap the first owner. A blocked identity resolves to
no session at all, even if its session row has not expired.

### Service admin

Search and list identities with verification state, blocking state and active session count, plus:

- send the ordinary one-time recovery link;
- resend the verification link of an unverified address;
- revoke all sessions of a user;
- **owner only** — block or unblock sign-in.

An administrator never sets or sees a password or a recovery token: recovery uses exactly the same
time-limited flow through Notifications and Email as a user-initiated request. Blocking
immediately revokes sessions and outstanding auth tokens. An owner cannot block their own
identity, so the action can never remove the last working owner session.

Every admin mutation requires both the Gateway-verified administrator context and a valid CSRF
token, is written to the Auth audit, and takes effect from the next request. Identity operations
are never moved into Users.

## Outgoing calls

Auth owns no email templates and no delivery. It reports typed events to Notifications, which
routes them to Email. The recipient locale is a product preference, so it is read from Users
through its contract — never from its database — and falls back to `en`.

A failed hand-off to Notifications never fails a security flow; it is logged instead.

## Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Base connection; Auth uses `<PROJECT_SLUG>_auth` on that server |
| `PROJECT_SLUG` | Database and cookie naming |
| `PUBLIC_SITE_URL` | Origin used to build verification and recovery links |
| `AUTH_SESSION_TTL_SECONDS` | Session lifetime, 30 days by default |
| `NODE_ENV` | `production` marks the session cookie `Secure` |

## Commands

```bash
pnpm --filter @template/auth test
```
