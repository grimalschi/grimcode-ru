# Email

Owns email templates, publication, sending and delivery records. Template content lives in the
project's database; the mail provider receives the rendered message.

## Integration

[`createModule({ env })`](src/index.ts) returns `internalCaller.send`, `adminFetch`, the Admin
description and `migrate()`. Notifications calls the [`EmailApi`](../../contracts/src/modules/email.ts):

```ts
await modules.email.send({ templateKey, to, variables, dedupeKey });
```

Administrators granted Email open the editor and delivery log at `/admin/module/email`.
The embedded screen and API live under `/admin/embed/module/email/`.
Mutations require the module's [CSRF token](../admin/README.md#csrf).
[`EmailEnv`](src/env.ts) supplies `databaseUrl`, `csrfCookieName` and `mail` settings.

## Templates

Each template has a stable key, declared variables and a series of versions. A version stores its
subject and MJML `source`. The admin screen edits MJML and previews the compiled email in an
isolated iframe.

Publishing checks `{{name}}` variables in the subject and source against the template's declared
variables. The server compiles MJML, sanitizes HTML and generates plain text from it.
Sanitization removes HTML comments, including Outlook conditional markup; test the resulting
layout in the mail clients supported by the product.
A transaction locks the template and draft, renders it and replaces the previous
publication. Concurrent saves cannot change that snapshot. A unique index permits one published
version per template. Published content stays fixed: changes start with a new draft.

Delivery fills `{{name}}` placeholders in the stored HTML and text, then sanitizes the HTML again
to reject unsafe URLs supplied through variables. Values are HTML-escaped where needed; missing
values retain their placeholders. The editor keeps one draft state for its subject and source.
Test sends save that state first. Invalid MJML can be saved as a draft; preview and publication
report compilation errors.

[MJML](https://documentation.mjml.io/) provides email layout components such as `mj-section`,
`mj-column`, `mj-text` and `mj-button`. Each source contains the complete email; file includes are
disabled.

For example, declare `name` and `confirmUrl` on the template, then use this source:

```xml
<mjml>
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-text>Hello, {{name}}.</mj-text>
        <mj-button href="{{confirmUrl}}">Confirm your email</mj-button>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
```

Sources are limited to 1,000,000 characters; rendered HTML to 5,000,000. An image-only or empty
message cannot be published because Email also produces a readable text alternative.

[`src/seed.ts`](src/seed.ts) defines the initial Auth templates. `migrate()` creates and publishes
missing templates while preserving existing content. Each initial template and its published version
are inserted atomically; concurrent starts and retries are safe. Add keys and variables alongside
the code that uses them; see the [notification map](../notifications/README.md#events).

## Delivery

Before sending, Email stores a content snapshot, recipient and transport in `email.deliveries`.
The unique `dedupeKey` reserves that delivery even for concurrent calls. Subsequent calls return
the stored record and status, including `failed` or `queued`, without another transport call.
A process interruption or a failed database write after provider acceptance can leave a delivery `queued`.

`sent` means the transport completed: `log` recorded the message locally, or UniSender Go accepted
it. The record includes the provider's message ID and response status; this is not confirmation of
receipt in the recipient's mailbox. A provider timeout can occur after acceptance, so inspect the
provider outcome before retrying with a new key.

The UniSender request has an eight-second deadline. The internal caller waits ten seconds, leaving
time to record the result; that caller deadline does not cancel the underlying operation.

Stored subjects, HTML and text replace URL parameters named `token` with `***` to protect one-time Auth links.
The administrative preview renders stored HTML in a sandboxed iframe without script or same-origin
permissions. Test sends use the selected transport and produce delivery records too.

## Transport

| Variable | Meaning |
| --- | --- |
| `EMAIL_PROVIDER` | `unisender` or `log`; empty or unset defaults to `log`, other values fail at startup |
| `EMAIL_FROM_ADDRESS` | Required sender address for UniSender Go |
| `EMAIL_FROM_NAME` | Optional sender name |
| `UNISENDER_GO_API_KEY` | Required UniSender Go API key |
| `UNISENDER_GO_API_URL` | Optional API base URL; empty or unset uses the built-in provider URL |

UniSender validates its configuration when the module is created. It hashes `dedupeKey` into a
64-character `idempotence_key` and requires a successful response with a provider message ID.
Provider-side deduplication depends on the provider's handling of that key.
Additional transports implement [`Transport`](src/transport.ts).

## Storage

The `email` schema contains `templates`, `template_versions`, `deliveries` and `email_audit`.
The audit records template administration, publication and test sends with the administrator's
identity and role. Schema changes use [module migrations](../../docs/development.md#migrations).
