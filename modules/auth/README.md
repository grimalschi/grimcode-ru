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
a conflict, and so does a request to change to an occupied email: registration already tells anyone
that an address is taken, so the change — behind the current password and the five-minute window —
says it too instead of pretending a letter went out. Recovery returns `ok` without revealing whether
the address exists. Changing the email, like changing the password, asks for the current
password first — an open session is not proof of who is at the keyboard — and the address is looked
at only after it matches. A request is recorded as `email.change_requested` (with `taken: true` for
an occupied address, which is refused and gets no link); the change itself as `email.changed`. Login uses one rejection message for invalid credentials and verifies
a dummy password hash when the identity is missing.

Sign-in permits ten attempts per email within fifteen minutes; success clears the counter.
The current password asked by the email and password changes has its own allowance: ten checks per
account within fifteen minutes, shared by both procedures and separate from sign-in. Past it the
password is not checked (`TOO_MANY_REQUESTS`), and the first refusal in a window is recorded once as
`password.check.limited`. Both limits are constants in [`public/index.ts`](src/public/index.ts).

Letters a person can trigger are limited where an account is known. Recovery sends one link per
account in fifteen minutes and always answers `ok`. A fresh verification link and an email-change link
go out at most once per account in five minutes; asking again inside the window gets
`TOO_MANY_REQUESTS` saying so; the link in the welcome letter counts, so a fresh one can be asked for
five minutes after registering. An email-change link also goes to one address at most once in five
minutes whichever accounts ask, answered with a quiet `ok` like a taken address and journaled as
`limited: 'address'` (`limited: 'account'` for the account window). These windows are rows in the
database, so they survive a restart. **Registration is not limited:** an address registers once, so
one person gets one welcome letter at most, but a script can register many addresses. Protecting it —
a rate limit by client address at the edge proxy, a CAPTCHA, bot protection — belongs to whoever
deploys the product; the application does not see the client address.
The counters belong to the process, so multiple application processes each have that allowance.
Configure client-address rate limits at the edge proxy.

Verification links last 24 hours; recovery and email-change links last one hour. Tokens are
consumed in the same transaction as the account change. Credential operations serialize on the
identity row; login rechecks the verified password hash and email before creating a session.
Issuing a replacement invalidates earlier tokens for the same purpose.
Password and email changes revoke all sessions and outstanding account links. A password change
opens a fresh session on the current device; an email change requires signing in again. Users see
their own sessions and end any one of them (`revokeOwnSession`, journaled as `session.revoked.self`)
or every one but the current browser (`revokeOtherSessions`, `sessions.revoked.others` with the count);
the current browser is ended by signing out. Another account's session id ends nothing and still
answers `ok`.
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
Blocking comes over the internal API (`setIdentityBlocked`), today from
[Admin](../admin/README.md#managing-access-and-preserving-an-owner). The call locks the identity
row, changes it, revokes sessions and account links, and writes `identity.blocked` or
`identity.unblocked` to `auth_audit` — all in one transaction, with the actor the caller passes from
its verified administrator context. Who may be blocked is Auth's own invariant, kept in data: an
identity marked `blocking_protected_at` (migration 002) is never blocked, whoever asks — the call
is refused with a conflict after the row lock, so a protection set or cleared in another
transaction is seen in order. The panel sets and clears the mark for its owners through
`setBlockingProtection`, which records `identity.protected` / `identity.unprotected` in the same
transaction; Auth never asks the panel anything. Unblocking ignores the mark. Auth's audit is where
all these events are found; the caller writes nothing of its own for them (entries recorded there
before this change stay where they are).
Router passes the verified [administrator context](../../contracts/README.md#http-context) as
`adminFetch(request, adminContext)`. Each request's Hono bindings carry that context and the module
settings; administrative identity does not come from HTTP headers. Administrative reads require
the context; mutations also require Auth's own [CSRF token](../admin/README.md#csrf) and are audited
with the actor from that context.
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

A security action and its `auth_audit` entry commit together or not at all: a procedure that
changes state asks the repository for a transaction (`repo.withTransaction`) and writes the change,
the audit entry and whatever else belongs to the action — the new session on registration and
password change, the login stamp on sign-in — through the repository bound to it. Repository methods
that would open their own transaction join the one already open. A failed audit write therefore
rolls the action back and the caller sees the error, instead of a change without its record. What the
database cannot roll back — the hand-off to Notifications — comes after the commit, and its failure
still leaves the action successful, as described above. [`transactions.test.ts`](src/transactions.test.ts)
reads the statement order on a recording pool for both outcomes.

The identity sequence defines registration order. Password hashing is in
[`src/crypto.ts`](src/crypto.ts); session and one-time tokens are stored as hashes in Auth.
Schema changes belong in [`src/db/migrations/`](src/db/migrations), following the
[migration instructions](../../docs/development.md#migrations).

Run `pnpm --filter @template/auth test` for module checks. See
[development guide](../../docs/development.md#checks) for application and browser checks.
