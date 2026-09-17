# Application tests

The HTTP suite checks module interactions through Router. Playwright checks the browser flows.
Run both against a dedicated disposable test installation with `EMAIL_PROVIDER=log`: the tests
create accounts and modify application data. A worktree alone does not establish database isolation.

## Test isolation

The first account in the installation handed to the user belongs to that user. Do not register a
test or demonstration account there, even if its database is empty. A request to start or test the
application does not authorize creating its first owner.

Before any acceptance, browser or manual write test:

1. Prepare a separate disposable database and a separate application process on a test port.
   Do not reuse the user-facing installation's database, even if its name contains `test`.
2. Explicitly supply the test process's `DATABASE_URL`, `PORT`, `PROJECT_SLUG`, `PUBLIC_SITE_URL`
   and `EMAIL_PROVIDER=log`. Keep the user-facing installation's configuration unchanged.
3. Supply the tests with `ACCEPTANCE_BASE_URL` pointing to that process, the same test `DATABASE_URL`,
   and that test installation's `ACCEPTANCE_OWNER_EMAIL` and `ACCEPTANCE_OWNER_PASSWORD`.
   Register a fixture owner only in this test installation.
4. Verify the effective configuration of both processes, including environment overrides: the HTTP
   target must actually use the disposable database. Compare database server and database identity
   with the user-facing installation; do not print connection passwords. Different ports or email
   prefixes do not isolate data. Different connection strings may still address the same database.
5. If the target or its database cannot be verified, stop before writing and report the missing setup.
   After the run, stop the test process and remove only the disposable database created for the run.

These are operating requirements, not an implemented automatic safety gate. The suites currently
load the root `.env` as a fallback. In addition, acceptance `resolveOwner()` registers a candidate
owner when credentials are absent: on an empty database that account becomes the owner. Never rely
on missing credentials or an empty database to prevent test writes.

## Setup and running

After verifying isolation, start the test application, register its fixture owner and open `/admin/`
to initialize the test registry. For an existing disposable test installation, use its test owner's
credentials. Pass the following through the test process environment:

| Variable | Value |
| --- | --- |
| `ACCEPTANCE_OWNER_EMAIL`, `ACCEPTANCE_OWNER_PASSWORD` | Test installation owner credentials |
| `ACCEPTANCE_BASE_URL` | Explicit address of the isolated test application |
| `DATABASE_URL` | The same disposable database used by that application; the HTTP suite inspects module schemas |

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
| Sign-in flows, application navigation and public SSR pages | [app.spec.ts](browser/app.spec.ts) |

Keep local validation and business rules in module tests; use these suites for behavior that crosses
module boundaries or depends on a browser. General checks are in the [development guide](../docs/development.md#checks).

PostgreSQL type and preservation checks belong to [Admin's database tests](../modules/admin/README.md#tests).
The database browser suite here verifies form input, exact strings, SQL NULL and escaped control characters.

## Test data

HTTP [fixtures](src/fixtures.ts) create accounts under a unique run prefix and reuse templates by
stable keys. Created accounts remain in the database. Cleanup restores changed administrator rights;
new administrator records are left disabled with empty grants. A failed cleanup can leave changed
permissions, so inspect the run's errors before reusing the database.
