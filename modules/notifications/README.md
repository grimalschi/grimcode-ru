# Notifications

Accepts typed events, chooses an email template and records the delivery attempt in
`notifications.events`. Callers describe what happened; Notifications owns the routing to Email.

## Integration

[`createModule`](src/index.ts) receives [`NotificationsEnv`](src/env.ts) and `modules.email`.
It returns `internalCaller.emit`, `adminFetch`, the Admin description and `migrate()`.
Callers use [`NotificationsApi`](../../contracts/src/modules/notifications.ts):

```ts
await modules.notifications.emit({ event, dedupeKey });
```

The Admin screen and API at `/admin/embed/module/notifications/` expose the event log to
administrators granted Notifications. Configuration supplies `databaseUrl`.
Router passes the verified administrator as `adminFetch(request, adminContext)`.
Hono bindings contain the module settings and the request's `adminContext`, which reaches the
administrative tRPC procedures.

## Events

| Event | Email template |
| --- | --- |
| `auth.user.registered` | `auth-welcome` |
| `auth.email.verification_requested` | `auth-verify-email` |
| `auth.password.reset_requested` | `auth-password-reset` |
| `auth.email.change_requested` | `auth-confirm-email-change` |
| `auth.email.changed` | `auth-email-changed` |

To add an event, extend the [contract](../../contracts/src/modules/notifications.ts),
[`vocabulary.ts`](src/vocabulary.ts), validation and template map in [`schemas.ts`](src/schemas.ts),
and add its template to [Email's seed](../email/src/seed.ts).
Template variables contain the recipient email and event payload.

## Delivery results

`emit` stores the event, then calls Email within the same operation. A unique `dedupeKey` identifies
one event: subsequent calls return its existing ID, including after a failed attempt. They do not
restart delivery. Email receives its own stable key, `notification:<event-id>`.

`ok: true` confirms event acceptance. Check the stored status for the outcome: `accepted` means
routing is pending, `routed` links an Email delivery, and `failed` records a delivery error or timeout.
A process interruption can leave an event `accepted`.

Internal calls stop waiting after ten seconds while the underlying operation can continue.
A timeout therefore leaves the eventual outcome uncertain; consult
[Email's delivery log](../email/README.md#delivery) before attempting another send.
