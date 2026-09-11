# Application tests

The HTTP suite checks module interactions through Router. Playwright checks the browser flows.
Run both against a development worktree with `EMAIL_PROVIDER=log`: the tests create accounts and
modify application data.

## Setup and running

Start the application, register its first account and open `/admin/` to initialize the owner.
For an existing database, use its owner's credentials. Set these in the root `.env` or process environment:

| Variable | Value |
| --- | --- |
| `ACCEPTANCE_OWNER_EMAIL`, `ACCEPTANCE_OWNER_PASSWORD` | Existing owner credentials |
| `ACCEPTANCE_BASE_URL` | Application address; defaults to loopback on `PORT`. |
| `DATABASE_URL` | The same database used by the application; the HTTP suite inspects module schemas |

Process environment values take precedence over `.env`. Install the browser once, then run either suite:

```bash
pnpm --filter @template/tests exec playwright install chromium
pnpm test:acceptance
pnpm test:browser
```

Run suites sequentially against a given database: they exercise changes to administrator access.
Playwright retains a trace on failure; browser helpers collect console errors and uncaught exceptions.

## Where to add a check

| Area | Test files |
| --- | --- |
| Roles, module grants, CSRF and routing | [access.test.ts](src/access.test.ts) |
| Sessions, recovery, blocking and owner preservation | [security.test.ts](src/security.test.ts) |
| Notifications, MJML publication and sending, profile flows | [flows.test.ts](src/flows.test.ts) |
| Admin navigation, embedded screens and theme | [admin-shell.spec.ts](browser/admin-shell.spec.ts) |
| Administrator menus, direct links, revoked access and cross-origin requests | [admin-access.spec.ts](browser/admin-access.spec.ts) |
| Database filters, URL state and row editing | [database.spec.ts](browser/database.spec.ts) |
| Email source editing, draft isolation, preview, publication and test sends | [email-admin.spec.ts](browser/email-admin.spec.ts) |
| Sign-in flows, application navigation and Site rendering | [app.spec.ts](browser/app.spec.ts) |

Keep local validation and business rules in module tests; use these suites for behavior that crosses
module boundaries or depends on a browser. General checks are in the [development guide](../docs/development.md#checks).

## Test data

HTTP [fixtures](src/fixtures.ts) create accounts under a unique run prefix and reuse templates by
stable keys. Created accounts remain in the database. Cleanup restores changed administrator rights;
new administrator records are left disabled with empty grants. A failed cleanup can leave changed
permissions, so inspect the run's errors before reusing the database.
