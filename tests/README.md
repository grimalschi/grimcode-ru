# Acceptance tests

Fifty-nine checks that run against a **running application**, over HTTP, through Gateway.

They deliberately do not import module code. A test that called a router directly would prove the
router works while saying nothing about whether Gateway lets the request through — and Gateway is
where access is actually decided. So they speak to the stack the way a browser does: one URL, one
cookie jar, one answer.

One check is the exception and speaks to PostgreSQL instead: that the five databases exist under the
names the modules were meant to get, each one distinct. It has to — a module creates its database on
the first request that needs it, so the check first asks every module for something, and what it
looks at afterwards is a fact of the server rather than anything an HTTP answer would show.

## Running them

```bash
pnpm test:acceptance
```

The suite reads `.env` itself, so it finds the port the stack is on. It needs an owner to work as:

| Variable | Meaning |
| --- | --- |
| `ACCEPTANCE_BASE_URL` | Only to aim the suite at another stack: it defaults to `GATEWAY_PORT` on loopback, so it is not in `.env`. |
| `ACCEPTANCE_OWNER_EMAIL`, `ACCEPTANCE_OWNER_PASSWORD` | An existing owner. Add them to `.env` when the stack already has accounts; the suite says so itself when it needs them. |

**On a stack with no accounts, leaving the credentials out is not enough**, and the file used to say
it was. Each of the three files resolves its own owner, so the first one to run registers an account
and becomes the owner, and the other two register accounts that are not — 17 checks pass and two files
fail with "this stack already has accounts". Measured on a clean stack, 21 August.

What works on a clean stack is letting it fail once and running it again with the owner it made: the
run id in `acceptance+<id>-owner@example.test` is the same id as in the password,
`acceptance-<id>-passphrase`.

## What they cover

**Who can open what** — [`access.test.ts`](src/access.test.ts)

Anonymous and ordinary users are refused the admin panel; the owner sees every service; an
administrator opens what they were granted and nothing else; a change or revocation of a grant takes
effect on the next request; a disabled administrator loses everything. The database section is
owner-only, cannot be granted to anyone at all, and has no public route — and the owner passing that
check reaches the interface, which lists this installation's five databases and refuses a changing
request that carries none of its headers. The admin **assets** are protected too, not
only its pages — serving them would hand out the panel itself. Forged `x-template-admin-*` headers
are replaced by Gateway, and a service that is not on the public allowlist answers 404 while the two
that are on it answer for themselves. A change sent without a CSRF token is refused with a 403, and
the registry will not let the last active owner be demoted or disabled — 409, naming the reason,
rather than a silent no-op.

**Security flows** — [`security.test.ts`](src/security.test.ts)

Revoking a session closes protected endpoints immediately. Signing out invalidates the session on
the server, so a copied cookie is worthless afterwards, and the cookie is cleared as well. Recovery
answers identically for a known and an unknown address, and an administrator triggering it never
receives the token. Guessing a password stops being answered after enough failures, and the correct
one is refused too for the rest of the window — otherwise the limit would only slow down a guess that
had already failed. A second address is unaffected while that lasts. Blocking is owner-only, prevents
signing in, is reversible, and an owner cannot block themselves — blocking another owner is allowed,
and the rule that keeps the panel reachable sits on the other side: taking the rights off the last
owner who can still enter is refused, counting a blocked owner as unable to.

**Across services** — [`flows.test.ts`](src/flows.test.ts)

A password reset in Auth becomes an event in Notifications and a stored message in Email. The
snapshot is checked from both sides: it carries the address that actually sets a password rather than
the form asking for another link, it has no unresolved placeholder left in it, and the token inside
that link is `***` — the log is a record, not a second copy of a one-time key. Publishing refuses a
document using an undeclared variable and names it. A published document keeps its `{{name}}`
placeholders, because the values are per recipient. Each service admin returns only its own service's
data — and the profile list fills in the sign-in address Users does not store, which is the one place
a failed call to Auth would show as an empty column rather than as an error. No internal surface is
reachable through Gateway, and the editor is absent from the central Admin bundle and from the Email
admin's first chunk. The public site renders on the server, answers an unknown address with a real 404, and keeps
`/app/`, `/admin/` and the placeholder pages out of `robots.txt` and the sitemap. The owner already
in place stays the owner, and registering promotes nobody.

## What they leave behind

Nothing that matters, and nothing that grows.

Accounts are created under a per-run prefix. An administrator whose access a test changed is put
back exactly as it was; one the run created is left disabled with no grants. The registry has no
delete operation on purpose — removing the record of who had access would defeat the audit.

Email templates are looked up by a stable key and created only when missing, so a hundred runs leave
one fixture template rather than a hundred.

## In a real browser

```bash
pnpm test:browser
```

Forty checks in Chromium, for the questions an HTTP request cannot answer. Fifteen of them also
fail on any console error or uncaught exception, so a bundle that renders but throws does not pass. It
is asked for per check, with `collectPageErrors`, and which ones ask is a choice rather than a rule.

**The shell** — [`admin-shell.spec.ts`](browser/admin-shell.spec.ts). The panel loads and renders;
the owner sees every service; the owner-only screens open. The theme applies, survives a reload
without flashing white, and **reaches an embedded service admin**, which then shows no switch of its
own. Navigation started inside an iframe is followed by the shell's URL and is **not** cancelled by
the shell sending its old path back — the failure this protocol exists to avoid. A deep link opens
straight into the embedded admin, and the same protected URL works on its own.

**The database section** — [`database.spec.ts`](browser/database.spec.ts). Fifteen checks, the most
of any file here, because this screen is the one nothing else covers: its own package's tests never
load it in a browser. It reads the catalogue of a live database, sorts through a column's own menu and
keeps the view in its URL, shows a cut value in full on hover and copies the whole of it on a click,
indents a json value, adds a filter without asking anything until a condition is chosen, offers only
the conditions that fit the column — and keeps its own panel open while one is picked, which is the
failure that panel had. It asks before deleting a row, shows a two-column key as that table's key, and
follows the theme the panel sends it — the one contract between a React shell and a frame that is not
React.

One check adds a row and takes it away again: the form asks for the key, because that table's key has
no default, while `details` and `created_at` have one and are left empty on purpose — an empty value
would be stored instead of the default. It also watches the count beside the table name go up by one
and back down, which the screen keeps in step itself. Another opens both dialogs to confirm a date is
picked in a calendar rather than typed, and that every type in the list says what it holds.

Three checks are about the shape of a table rather than its rows: a column is added, offered what a
migration's column is never offered and dropped again; a new column made required offers a default,
because without one the module's next insert would fail; and `schema_migrations`, which records what
has been applied, offers no new column at all.

The two that really add a column need somewhere to write it. A change of shape is written into a
project as a migration, so a copy started for this suite has to be given a scratch tree with
`SCHEMA_SOURCE_ROOT` — a copy of `modules/*/src/db/migrations` is enough. Both refuse to run against a
copy that would write into the repository under test, and say so.

**The email admin** — [`email-admin.spec.ts`](browser/email-admin.spec.ts). Templates list, the
editor opens on its own route and runs, a delivery shows its stored message as a preview and as
source, and the preview frame is fully sandboxed — Chromium refusing to run anything inside it is
expected and is not counted as an error.

**The application, and the site beside it** — [`app.spec.ts`](browser/app.spec.ts). An anonymous
visitor is sent to sign in and never sees the protected interface, not even for a moment; the page
they wanted is remembered; an external URL, a protocol-relative one, the admin panel and the login
page itself are all refused as return paths. Signing in returns them where they were going, and
signing out puts them back out.

The same file carries two more blocks. A recovery link opens the screen that sets a new password, and
one arriving without a token says so instead of pretending. The public site renders, links into the
application, and answers an unknown address with a not-found page of its own.

Chromium is installed once with:

```bash
pnpm --filter @template/tests exec playwright install chromium
```
