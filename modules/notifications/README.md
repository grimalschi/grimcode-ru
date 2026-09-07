# notifications

Accepts typed events from services and routes them to Email.

Notifications stores no email templates and never reads another service's database. It is a
routing layer with a memory, not a mail service.

## Closed set of events

Only the event types declared in `shared/src/vocabulary.ts` are accepted. The contract is a
discriminated union, so an unknown type is rejected by validation before it can reach storage.

The template ships the base auth events needed for registration, email verification, account
recovery and email change:

| Event | Email template |
| --- | --- |
| `auth.user.registered` | `auth-welcome` |
| `auth.email.verification_requested` | `auth-verify-email` |
| `auth.password.reset_requested` | `auth-password-reset` |
| `auth.email.change_requested` | `auth-confirm-email-change` |
| `auth.email.changed` | `auth-email-changed` |

A product adds its own events by extending the contract and this map — not by accepting free-form
payloads.

## Protection against repeated processing

Every `emit` carries a caller-supplied `dedupeKey`. The unique index on `events.dedupe_key` is what
actually prevents a repeated delivery from being routed twice: the second call reports the stored
event and does nothing else. Email deduplicates on its own side as well, so even a retried routing
cannot send the same message twice.

## Failures stay visible

If Email cannot be reached, the event is kept with status `failed` and the error message. It shows
up in the service admin instead of disappearing into a log line.

**`failed` means the routing was not confirmed, not that no message was sent.** A deadline is one way
to get it: Email puts `RPC_TIMEOUT_MS` on the caller it hands out, and its own call to the provider
is deliberately given less than that, so the answer arrives while there is still someone waiting for
it. What that buys is the two logs agreeing; it does not make a timeout mean nothing was sent —
a provider can accept a message and answer too late to say so. When an event is `failed` with a
timeout rather than a refusal, the delivery log in Email is what says whether anything went out.

## Surfaces

| Mount | Reachable as | Callers |
| --- | --- | --- |
| *not mounted* | the internal procedures are called directly, in-process | Auth, emitting events |
| `/admin/embed/service/notifications/rpc` | through Gateway's admin route | administrators granted Notifications |

Notifications has **no public surface**: it is deliberately absent from Gateway's public
allowlist, so no browser can emit an event.

### What Auth may see of this module

The admin screen's client is typed from this module's router, and Auth is typed from the caller this
module hands out; either way a type has to cross the module boundary. It crosses through one named
door and no other: `@template/notifications/contract` resolves to
[`src/contract.ts`](src/contract.ts), which re-exports the admin router type, that caller type, the
`NotificationEvent` Auth builds and the `StoredNotificationEvent` the admin screen renders — and
nothing else, while the bare `@template/notifications` resolves to `createModule` and the
`NotificationsEnv` type and nothing besides. The repository, the migrations and the routing to Email
are reachable by no specifier at all.

That door is not an agreement about behaviour: it decides which files are visible, not what ends up
in the type. What keeps the type honest is the `.output()` schema every procedure declares and the
`satisfies` line beside each router, which refuses to compile when the router holds a name the
surface is not allowed to hold.

The admin surface issues a CSRF cookie like every other, and no call carries a token — because
nothing on it changes anything. An event is a record of what happened, and a log that can be edited
is not a record.

There is no code here that would send one either. Adding a mutation to this surface therefore means
adding both halves by hand: `requireCsrf` on the procedure, and a `headers` option on the browser
client that sends the token on mutations — [`modules/email/web/src/api.ts`](../email/web/src/api.ts)
is the working pattern. Neither half arrives on its own, and nothing here fails if they are
forgotten, which is why it is written down.

## Data

Database `<PROJECT_SLUG>_notifications`, single `events` table, created and opened by this module
itself. Migrations are in [`src/db/migrations/`](src/db/migrations) and are applied by the
module itself, on the first request that opens its pool.

## Environment

Nothing in this module reads it: the composer reads these and hands over what belongs to this
module on `c.env`. What follows is what a deployment sets on its behalf.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Base connection; Notifications uses `<PROJECT_SLUG>_notifications` |
| `PROJECT_SLUG` | Database naming |

## Commands

```bash
pnpm --filter @template/notifications test
```
