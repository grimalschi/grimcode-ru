# Auth

Auth owns user identities, sign-in, sessions, email verification, account recovery and the security audit.

## Integration

```ts
const auth = createModule({ env, modules: { notifications: notifications.internalCaller } });
```

The instance exposes public and administrative HTTP handlers, `internalCaller`, `admin` metadata
and `migrate`. [`@template/contracts/modules/auth`](../../contracts/src/modules/auth.ts) defines
`AuthApi` for internal callers and `AuthPublicRouter` for other modules' browser clients.

| Entry | Purpose |
| --- | --- |
| `/module/auth/rpc` | Registration, sign-in, sessions, verification and account recovery |
| `/admin/embed/module/auth/` | Identity management interface and its RPC API |
| `internalCaller` | Session validation and revocation, identity lookup and registration order |

`resolveSession` returns an identity only for an active session and unblocked account.
`revokeSessionByToken` invalidates a session for callers such as Admin logout. `getFirstIdentity`
supplies the identity for Admin's first owner; batch and search methods supply identity details
to Admin and Users. The batch lookup accepts up to 200 IDs.

## Authentication behavior

Registration opens a session and sends a verification link. Registering an existing email returns
a conflict. Recovery and requests to change to an occupied email return `ok` without revealing
whether the address exists. Login uses one rejection message for invalid credentials and verifies
a dummy password hash when the identity is missing.

Sign-in permits ten attempts per email within fifteen minutes; success clears the counter.
The counter belongs to the process, so multiple application processes each have that allowance.
Configure client-address rate limits at the edge proxy.

Verification links last 24 hours; recovery and email-change links last one hour. Tokens are
consumed in the same transaction as the account change. Credential operations serialize on the
identity row; login rechecks the verified password hash and email before creating a session.
Issuing a replacement invalidates earlier tokens for the same purpose.
Password and email changes revoke all sessions and outstanding account links. A password change
opens a fresh session on the current device; an email change requires signing in again. Users can
also list and revoke their own sessions.
The public API accepts JSON RPC requests; cookies use `SameSite=Lax`.

### Session cookies

Auth issues `sessionCookieName` with `Path=/`, `HttpOnly`, `SameSite=Lax` and `Max-Age` equal to
the session lifetime. `Secure` follows an HTTPS `publicOrigin`.

Logout revokes the stored session before sending an expired cookie with the same attributes and
`Max-Age=0`. Failed revocation leaves the cookie unchanged, allowing logout to be retried.
Admin follows the same sequence through `revokeSessionByToken` and receives the same cookie name
and origin. See [`src/http/cookies.ts`](src/http/cookies.ts).

## Administrative operations

Administrators granted Auth access can search identities, inspect verification and blocking state,
send recovery or verification links, revoke sessions and read the security audit.
[Admin](../admin/README.md#managing-access-and-preserving-an-owner) manages blocking together
with administrator rights to preserve an enabled owner. Its internal `setIdentityBlocked` call
changes Auth state and revokes sessions and account links atomically. The call waits for the
transaction to finish so Admin keeps its owner-preservation lock until the change completes.
Administrative reads validate [Router context](../router/README.md#trusted-administrator-headers);
mutations require Auth's own [CSRF token](../admin/README.md#csrf) and are audited.
The embedded interface follows the [Admin frame protocol](../admin/README.md#frame-protocol).

## Account messages

Auth sends events through `modules.notifications.emit`; [Notifications](../notifications/README.md)
routes them to Email. Auth logs hand-off failures without including event payloads; notification
failure leaves the authentication operation successful. Notifications and Email keep processing
and delivery logs.

Public recovery permits one new link per identity every fifteen minutes while a previous link is
active. The issuance transaction checks that interval before replacing a token, so repeated or
concurrent requests keep the previously sent link usable. Each issued link has its own notification
key.

## Configuration and data

[`AuthEnv`](src/env.ts) receives `databaseUrl`, `publicOrigin`, `sessionCookieName`, `csrfCookieName`
and optional `sessionTtlSeconds`. The origin builds account links and determines cookie security.
Session lifetime defaults to 30 days and must be a positive safe integer; it controls both stored
expiry and cookie lifetime. Composition maps `AUTH_SESSION_TTL_SECONDS` to this setting.

Auth owns schema `auth`:

| Table | Contents |
| --- | --- |
| `identities` | Email, password hash, verification and blocking state, registration sequence |
| `sessions` | Session token hashes, expiry and revocation |
| `auth_tokens` | Single-use token hashes, purpose and expiry |
| `auth_audit` | Security actions and actors |

The identity sequence defines registration order. Password hashing is in
[`src/crypto.ts`](src/crypto.ts); session and one-time tokens are stored as hashes in Auth.
Schema changes belong in [`src/db/migrations/`](src/db/migrations), following the
[migration instructions](../../docs/development.md#migrations).

Run `pnpm --filter @template/auth test` for module checks. See
[development guide](../../docs/development.md#checks) for application and browser checks.
