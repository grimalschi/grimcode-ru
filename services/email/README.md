# email

Template versions, publishing, delivery, provider statuses and the unchangeable history of what was
actually sent.

## Templates and versions

A template has a stable `key`, a human name and the list of variables it may use. Each template has
a series of versions, and at most one of them is **published** — a partial unique index guarantees
it, so runtime delivery is never ambiguous about which content to send.

There is **one language**. Several are a real feature, but not one a template can guess the shape
of: which language to send in depends on what a product knows about a person, and a template that
invented an answer would leave every project unpicking it. A product that needs them adds the column
back knowing how it chooses.

The editor's own document is stored verbatim in `editor_document`, next to `editor_format`, the
marker of the format it was written in. A new editor library never rewrites stored documents on
start: moving the marker forward is a separate Email migration.

Seed templates for the auth flows are created directly in the editor format, already published, so
a fresh installation can send mail immediately. Existing templates are never overwritten, so local
edits survive a restart.

| Key | Sent when |
| --- | --- |
| `auth-welcome` | a user registers |
| `auth-verify-email` | a verification link is requested or resent |
| `auth-password-reset` | recovery is requested by the user or by an administrator |
| `auth-confirm-email-change` | a user asks to change their address |
| `auth-email-changed` | notice to the previous address |

Templates are not created from the admin panel. A template only means something once code sends it,
and its key and the variables it may use are that code's side of the agreement — inventing them in a
form would produce a template nothing ever delivers. They are added to the seed and appear on the
next start. The panel is for the wording.

The `createTemplate` procedure remains, because that is how the seed and anything automating it do
the creating.

## Publishing is where the server takes over

On publish the server:

1. checks that the document only uses variables the template declares — a runtime delivery must
   never discover that a value has no source;
2. renders the document, leaving `{{name}}` placeholders in place, because the actual values are
   only known per recipient;
3. sanitizes the produced HTML;
4. derives the plain text **from that HTML**, so the two versions cannot drift apart;
5. archives the previously published version in the same transaction.

Runtime delivery then sends this stored result and never re-renders. An editor library upgrade can
therefore not change a message that a human already approved, and the editor is never loaded at
delivery time.

Values are filled into the published content at send time: escaped on the way into the HTML, raw
into the text. A placeholder without a value is left visible rather than blanked, so a missing
value is noticed.

## Editor

The service admin embeds the open-source **Maily** editor, self-hosted as part of this service's
own build and loaded only on the editor route. No external CDN and no hosted editor is used, and
the editor bundle is not part of the central Admin or of runtime delivery.

Images are stored inline in the document, so a published message never depends on an asset that
might later disappear.

## Transport

Locally, `EMAIL_PROVIDER=log` keeps messages inside the delivery log and nothing leaves the
machine. The single ready production transport is **UniSender Go**. Both implement one small
interface, so a project adds another provider with an ordinary code change rather than a
configuration matrix.

The caller's dedupe key is passed to the provider as its idempotency key, so a retry cannot send
the same message twice.

## Delivery log

Every message is recorded **before** the transport runs, so nothing can leave the system without
being in the log. A row holds the immutable snapshot of exactly what was sent: subject, full HTML,
full plain text, recipient, time, transport and the known provider status.

The list never carries message bodies; a body is fetched one record at a time. The log reads only
the Email database, and its contents are never handed to the central Admin bundle or to another
service. In the admin interface the HTML is shown both as escaped source and as a preview in a
sandboxed iframe without scripts and without access to the admin origin.

A test send is a real send: it goes through the transport and is recorded with the exact content
that left the system.

## Surfaces

| Mount | Reachable as | Callers |
| --- | --- | --- |
| `/internal/rpc` | internal Docker network only | Notifications |
| `/admin/embed/service/email/rpc` | through Gateway's admin route | administrators granted Email |
| `/admin/embed/service/email/**` | through Gateway's admin route | the built service admin |

Email has **no public surface**: it is absent from Gateway's public allowlist.

## Data

Database `<PROJECT_SLUG>_email`. Migrations are in [`src/db/migrations.ts`](src/db/migrations.ts).

## Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Base connection; Email uses `<PROJECT_SLUG>_email` |
| `EMAIL_PROVIDER` | `log` locally, `unisender` in production |
| `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME` | Sender identity |
| `UNISENDER_GO_API_KEY`, `UNISENDER_GO_API_URL` | UniSender Go credentials |

## Commands

```bash
pnpm --filter @template/email test
```
