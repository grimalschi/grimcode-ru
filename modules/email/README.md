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
being in the log. A row holds the snapshot of what was sent: subject, HTML, plain text, recipient,
time, transport and the known provider status. One thing is blunted on the way in — a `token=` in a
link is stored as `token=***`, so the log cannot become a second copy of a one-time key.

The list never carries message bodies; a body is fetched one record at a time. The log reads only
the Email database, and its contents are never handed to the central Admin bundle or to another
service. In the admin interface the HTML is shown both as escaped source and as a preview in a
sandboxed iframe without scripts and without access to the admin origin.

A test send is a real send: it goes through the transport and is recorded like any other.

## Surfaces

| Mount | Reachable as | Callers |
| --- | --- | --- |
| *not mounted* | the internal procedures are called directly, in-process | Notifications |
| `/admin/embed/service/email/rpc` | through Gateway's admin route | administrators granted Email |
| `/admin/embed/service/email/csrf` | through Gateway's admin route | the admin screen, before every mutation |
| `/admin/embed/service/email/**` | through Gateway's admin route | the built service admin |

Email has **no public surface**: it is absent from Gateway's public allowlist.

### What Notifications may see of this module

The editor screen's client is typed from this module's router, and Notifications is typed from the
caller this module hands out; either way a type has to cross the module boundary. It crosses through
one named door and no other: `@template/email/contract` resolves to
[`src/contract.ts`](src/contract.ts), which re-exports the admin router type, that caller type and
`EditorDocument`, the stored document the editor screen reads — and nothing else. `@template/email`
is the other entry and belongs to the composer, not to a neighbour: `createModule`, the `EmailEnv`
type and `MailSettings`, the shape of what arrives on `c.env`. Seeding the templates is this module's
own business now and no specifier reaches it. The repository, the
transport and the renderer are reachable by no specifier at all — which matters here more than
elsewhere, because `@maily-to/render` is the one CPU-bound dependency in the process.

That door is not an agreement about behaviour: it decides which files are visible, not what ends up
in the type. What keeps the type honest is the `.output()` schema every procedure declares and the
`satisfies` line beside each router, which refuses to compile when the router holds a name the
surface is not allowed to hold.

## Data

Database `<PROJECT_SLUG>_email`, created and opened by this module itself and touched by no other
module. Migrations are in [`src/db/migrations/`](src/db/migrations) and are applied by the
module itself on the first request that opens its pool, which is also when the seed templates appear.

`email_audit` records who changed what — a template created or updated, a draft made, a version
published, a test sent — with the administrator and their role. It is read through the panel's
database section and nowhere else: this module never reads it back, deliberately, because the delivery
log is what answers questions about mail. Auth and Admin do surface their own audits, so expect the
difference.

## Environment

Nothing in this module reads it. The composer reads the mail settings and the connection string of this
module's database, and both arrive on `c.env` with every request — the module creates and opens the
database itself from that string. What follows is what a deployment sets on this module's behalf.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL`, `PROJECT_SLUG` | The composer derives `<PROJECT_SLUG>_email` from these; the module creates and opens it |
| `EMAIL_PROVIDER` | `log` locally, `unisender` in production; anything else, empty included, records without sending |
| `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME` | Sender identity; UniSender Go refuses to send without an address |
| `UNISENDER_GO_API_KEY`, `UNISENDER_GO_API_URL` | UniSender Go credentials; an unset URL means the provider's own |

## Commands

```bash
pnpm --filter @template/email test
```
