# Acceptance tests

Fifty checks that run against a **running stack**, over HTTP, through Gateway.

They deliberately do not import service code. A test that called a router directly would prove the
router works while saying nothing about whether Gateway lets the request through — and Gateway is
where access is actually decided. So every check here speaks to the stack the way a browser does:
one URL, one cookie jar, one answer.

## Running them

```bash
pnpm test:acceptance
```

The suite reads `.env` itself, so it finds the port the stack is on. It needs an owner to work as:

| Variable | Meaning |
| --- | --- |
| `ACCEPTANCE_BASE_URL` | Where the stack answers. Defaults to `GATEWAY_PORT` on loopback. |
| `ACCEPTANCE_OWNER_EMAIL`, `ACCEPTANCE_OWNER_PASSWORD` | An existing owner. |

On a stack with no accounts at all, the credentials can be left out: the suite registers the first
account, which becomes the owner — the rule it is testing anyway.

## What they cover

**Who can open what** — [`access.test.ts`](src/access.test.ts)

Anonymous and ordinary users are refused the admin panel; the owner sees every service; an
administrator opens what they were granted and nothing else; a change or revocation of a grant takes
effect on the next request; a disabled administrator loses everything. Adminer is owner-only, cannot
be granted to anyone at all, and has no public route. The admin **assets** are protected too, not
only its pages — serving them would hand out the panel itself. Forged `x-template-admin-*` headers
are replaced by Gateway.

**Security flows** — [`security.test.ts`](src/security.test.ts)

Revoking a session closes protected endpoints immediately. Signing out invalidates the session on
the server, so a copied cookie is worthless afterwards, and the cookie is cleared as well. Recovery
answers identically for a known and an unknown address, and an administrator triggering it never
receives the token. Blocking is owner-only, prevents signing in, is reversible, and an owner cannot
block themselves.

**Across services** — [`flows.test.ts`](src/flows.test.ts)

A password reset in Auth becomes an event in Notifications and a stored message in Email, whose
snapshot carries the real one-time link and no unresolved placeholder. Publishing refuses a document
using an undeclared variable and names it. A published document keeps its `{{name}}` placeholders,
because the values are per recipient. Each service admin returns only its own service's data, no
internal surface is reachable through Gateway, the editor is absent from the central Admin bundle,
the real Adminer survives its own redirect and cookie, and the public site renders on the server.

## What they leave behind

Nothing that matters, and nothing that grows.

Accounts are created under a per-run prefix. An administrator whose access a test changed is put
back exactly as it was; one the run created is left disabled with no grants. The registry has no
delete operation on purpose — removing the record of who had access would defeat the audit.

Email templates are looked up by a stable key and created only when missing, so a hundred runs leave
one fixture template rather than a hundred.

## What is not here

Anything that needs a real browser: theme synchronisation between the shell and an embedded admin,
nested iframe navigation, computed colours in Adminer's own light and dark themes, and JavaScript
runtime errors in the production bundles. Those belong in a browser suite.
