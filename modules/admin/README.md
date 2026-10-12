# Admin

Admin owns administrator roles, module grants, their audit history, the panel shell and the
database browser. Administrators sign in through [Auth](../auth/README.md).

## Integration

```ts
const admin = createModule({ env, modules: { auth: auth.internalCaller }, catalogue });
```

The instance exposes `adminFetch`, `internalCaller` and `migrate`.
[`AdminApi`](../../contracts/src/modules/admin.ts) defines the internal authorization call.
`catalogue` supplies installed modules' `{ id, admin: { title, icon, assignable? } }` descriptors;
IDs must be unique and path-safe. `assignable: false` makes a module owner-only; the default is true.
The panel's `session` procedure returns the permitted descriptors, which drive navigation and grants.
`icon` is a kebab-case ID from [Lucide](https://lucide.dev/icons/), for example `mail` or `key-round`.
The sidebar loads icons locally on demand; an unknown ID falls back to `app-window`.

| Address | Purpose |
| --- | --- |
| `/admin/rpc` | Panel tRPC API, including `database.*` |
| `/admin/csrf` | Panel mutation token |
| `/admin/module/:id` | Embedded module's screen |
| `/admin/administrators`, `/admin/audit` | Administrator management and access history |
| `/admin/database` | Database browser |

## Authorization and roles

Router calls `authorize({ sessionToken, target })` for every administrative request. Admin resolves
the Auth session and checks the administrator's enabled state, role and grants. An owner can access
every installed module; an ordinary administrator can access granted, assignable modules.
Administrators, Admin audit and the database browser require the owner role in their server procedures.
Role and grant changes take effect on the next request.

Authorization results and denial reasons are defined in
[`AdminApi`](../../contracts/src/modules/admin.ts); [Router](../router/README.md#administrative-authorization)
turns them into HTTP responses. Router passes the verified `AdminContext` as the second argument
to `adminFetch(request, adminContext)`. Hono exposes module settings and this request's context
through `c.env`; tRPC procedures receive `ctx.env` and `ctx.adminContext` and enforce any finer permissions.

### First owner

The first administrative request with a valid session initializes an empty registry from Auth's
earliest registered identity. Ownership follows registration order, even if another user opens the
panel first. A transaction and unique bootstrap record make concurrent initialization produce one
owner and one audit entry. With no registered identities, the panel asks for registration.

### Managing access and preserving an owner

Owners add registered users by email, assign roles and module grants, and enable or disable
administrators. Administrator records, grants and their audit entry are saved in one transaction;
a failed lookup or audit write leaves the previous access intact. Disabling keeps the administrator's history.

Administrator additions, role changes and identity blocking share a registry lock. Inside it, Admin rechecks the actor's
session and role and asks Auth which remaining owners can sign in. This preserves an accessible
owner when requests overlap. The “Блокировка аккаунтов” dialog searches all Auth identities;
blocking revokes their sessions and recovery tokens through Auth's internal API. Admin passes the
verified actor along, and Auth records `identity.blocked` / `identity.unblocked` in its own audit in
the same transaction as the change — so those events live in Auth's audit (its module admin), not in
`admin_audit`; rows written there before this change remain as history.

The administrator list and its email search resolve current addresses through Auth.

### CSRF

Each administrative surface with mutations has its own `csrfCookieName`. Its CSRF endpoint returns `{ token }`,
reuses a valid existing token, sets a readable `Path=/; SameSite=Lax` cookie and sends
`Cache-Control: no-store`. The browser repeats
the token in `x-csrf-token`; mutations compare that header with the same surface's cookie using a
length check and constant-time comparison. Every new mutation needs this guard.

Admin's procedure builders combine these checks: `adminProcedure` validates administrator context,
`ownerProcedure` also requires owner, and their `*Mutation` variants additionally require CSRF.
Panel logout revokes the session through Auth before clearing the cookie, following the
[session cookie protocol](../auth/README.md#session-cookies).

## Embedded interfaces

The shell owns navigation and theme preference. Links to the public site and application open new tabs and use muted
styling to distinguish them from navigation within Admin. The mobile menu opens and closes at the same
screen position, so the user can tap twice without moving their finger. Each embedded module owns its interface.
For example, `/admin/module/email#/templates/123` opens the frame at
`/admin/embed/module/email/templates/123`.

### Frame protocol

Message types are defined in [`@template/contracts/admin-frame`](../../contracts/README.md#admin-frames).
Both ends send `postMessage` to their exact origin and check `event.origin` and `event.source`.
The shell accepts messages from its current iframe; the module accepts messages from its parent.

| Direction | Message object |
| --- | --- |
| Shell → frame | `{ type: 'template.admin.theme', theme: 'light' \| 'dark' \| 'system' }` |
| Shell → frame | `{ type: 'template.admin.navigate', path: string }` |
| Frame → shell | `{ type: 'template.admin.ready' }` |
| Frame → shell | `{ type: 'template.admin.path', path: string }` |

Paths are module-relative, start with `/` and collapse repeated slashes. A child reports its path
to update the outer URL. The shell sends `navigate` when the requested path changes, and sends the
theme on load, readiness and preference changes. Frame load only synchronizes the theme: replaying
the outer path could undo navigation that started inside the frame.

Embedded modules follow the shell's theme; directly opened modules use their own preference.
`system` follows `prefers-color-scheme`, with the resolved `light` or `dark` value in `data-theme`.
The shell implementation is in [`web/src/frame/`](web/src/frame).

### Connecting an interface

Set the module SPA's Vite `base` and router `basepath` to `/admin/embed/module/<id>/`.
Serve its assets and RPC through `adminFetch`; add a CSRF endpoint for mutations. Return `admin`
metadata and connect both through composition. The browser uses its own server's router type and administrative RPC
prefix. Implement the frame protocol and verify direct links, navigation and access through Router.

The panel and embedded SPA handlers serve `index.html` for navigation paths. Their `assets/`
directories are reserved for static files; missing files there return `404` after Router checks
administrator access.

For an Admin-owned section, register its route in [`main.tsx`](web/src/main.tsx) and navigation in
[`app-sidebar.tsx`](web/src/components/app-sidebar.tsx). Owner-only sections require a server owner
check for every procedure as well as the browser guard.

## Database browser

`/admin/database` reads and edits rows across user schemas through Admin's PostgreSQL pool.
`database.schemas`, `tables` and `rows` discover tables and load filtered, sorted pages;
`insert`, `update` and `delete` modify rows. View settings are stored in the page URL.

Every procedure requires owner; mutations also require Admin's CSRF token. Identifiers are checked
against PostgreSQL's catalogue and values are SQL parameters. System schemas and `schema_migrations`
are excluded at the API boundary.

Filter conditions are a closed list per column type ([`filters.ts`](src/admin/database/filters.ts)):
text, numbers and dates, booleans, uuid, json, arrays, ranges and network addresses each get their
own set, and a condition outside the column's set is refused. Every "… or empty" condition
(`IS DISTINCT FROM`, `IS NULL OR … NOT ILIKE`) exists because SQL drops an empty cell from any
negative comparison; "is empty" is SQL NULL only, and text has "empty string" separately. Arrays are
asked about elements (`= ANY`, `@>` cast to the column's own type from the catalogue, `cardinality`),
json about keys and dotted paths (`jsonb_exists`, `#>>`), ranges whether they contain a value (`@>`
cast to the element type). Values are always parameters; the only type names in SQL come from the
catalogue. [`filters.postgres.test.ts`](src/admin/database/filters.postgres.test.ts) runs every
condition against real PostgreSQL.

Conditions form a chain: each one after the first carries `join`, `and` or `or`, and the chain reads
as SQL does — `and` binds tighter, so `a OR b AND c` is `a OR (b AND c)`. `whereClause` writes every
group of `and`-joined conditions in parentheses, and the panel draws those groups as blocks, with a
handle to reorder conditions. `caseSensitive` turns `ILIKE` into `LIKE` for the text-matching
conditions; `=` and `IN` never ignore case. While any condition in the panel is unfilled the screen
sends no request and keeps the last page: leaving one condition out of a chain would change what its
neighbours' joins mean. Filters in the page URL carry `join` and `caseSensitive`; an address from
before the chain (`combine`) is read as every join.

The filter, sorting and visibility panels float over the table in a `Popover` under their buttons
rather than pushing the table down; they close on a click outside or Escape, and what they set
lives on in the page URL, with a count on each button. The calendar inside the filter panel is a
nested popover. The visibility panel ([`visibility.tsx`](web/src/database/visibility.tsx)) is a box
per column, the last visible one not to be unticked; "Скрыть колонку" in a column header hides it
and opens the panel, as "Фильтровать" opens the filter panel with the new condition.

Sorting is set only in its panel ([`sorting.tsx`](web/src/database/sorting.tsx)): levels in the order
they apply, the first deciding and each next breaking ties, a column used by one level not offered to
another, levels reordered by dragging or arrow keys ([`drag-order.tsx`](web/src/database/drag-order.tsx),
shared with the filter panel). The column header shows the arrow and, with several levels, the level
number, but its menu does not sort. The server appends the key as the last level itself.

A `date` or `timestamp` column gets a calendar beside each text box
([`date-field.tsx`](web/src/database/date-field.tsx), shadcn `Calendar` over `react-day-picker`):
picking a day writes `YYYY-MM-DD`, and for a column with a time of day `YYYY-MM-DD HH:MM` with a time
box under the month, midnight until changed. The text box stays free: seconds or a zone are typed
by hand, and the value goes to PostgreSQL as typed, in the editor's UTC session.

When PostgreSQL refuses a value a person typed — a data exception (class 22), a broken constraint
(class 23) or a malformed `tsvector`/`tsquery` (`42601`, the one syntax error that is the value's
fault) — the answer is 400. [`errors.ts`](src/admin/database/errors.ts) rewrites class-22 texts to say
what the column takes and repeat the value (`Ожидается целое число, например 42. Получено: «abc»`);
constraint texts stay PostgreSQL's, with the key from `detail` appended for duplicates and missing
references. The original error remains the `cause`. Matching is against English messages; a server
with another `lc_messages` falls back to the original text with the same status.

### Preservation comes first

The editor must preserve data rather than guess a conversion. A type, value or table structure whose
safe handling is unproven stays read-only until support and real PostgreSQL editing tests are added.
This rule applies to the server as well as the interface.
Editing currently requires a UTF8 database; other server encodings remain read-only until their
text conversion is covered by tests.
If column privileges hide any physical column from the catalogue, available fields remain readable
but the entire table is read-only: a partial original row cannot prove preservation.

Cells travel as PostgreSQL's native text or SQL NULL, using query-local text parsers. Numeric, date,
JSON, array and binary values are never converted through JavaScript numbers, dates or objects on
the write path. Connection formatting is fixed within the editor's transaction. The form distinguishes
an empty string, the text `null`, SQL NULL and an omitted value that uses the column default.
The mode (value, SQL NULL, default — only those the column allows) and the escaping box live in a
popover behind a settings icon opposite the field name (`FieldSettings` in
[`row-editor.tsx`](web/src/database/row-editor.tsx)); the icon is tinted while either is set, with
no tooltip of its own, and a box in SQL NULL or default mode shows the mode as its placeholder.
A locked field carries a lock beside its name, and why it is locked shows on hover over the lock.
Such a box is not disabled: clicking into it switches the field to a value so one can type, and
leaving it with nothing typed switches it back, so a stray click never turns NULL into an empty
string; a mode picked in the panel stays.
Control characters use a reversible JSON **string** wrapper; it does not parse the cell's JSON content.
A table cell spells them out the same way (`\r`, `\n`, `\t`, `\u0001`), dimmed, instead of the space
or nothing a browser draws for them (`controlSegments` in [`model.ts`](web/src/database/model.ts)):
what the cell shows is what a text condition can be given: on a text column (one the server offers
"empty string" to) a value for a matching condition is read back through `decodeFilterValues` —
`\r`, `\n`, `\t`, `\b`, `\f`, `\uXXXX` become the characters, `\\` one backslash, any other
backslash stays — before the request leaves the screen, while the page URL keeps the spelling.
The server sees characters only. The hover preview also breaks the line after `\n`; copying a cell
hands over the original bytes.
Paste captures the original clipboard text. Drag-and-drop is refused because browser text controls
can normalize line endings before the editor receives the value.
Copy uses the Clipboard API; if unavailable or denied, it reports failure.

A write follows these conditions:

1. Lock the relation and refresh its metadata. Accept only explicitly supported types and table
   structures; apply operation-specific restrictions, including refusal of cascading deletion.
2. For an update or delete, lock the row by its complete primary key and compare every cell with
   the original row sent by the editor. A concurrent change is a conflict.
3. Parse each proposed value through its PostgreSQL column type, including length and precision.
   Its native output must equal the supplied text exactly. Rounding, truncation and normalization
   cause an error; the editor never silently substitutes the converted value.
4. Update only changed fields. Verify the returned row against the expected values, including all
   untouched fields, and require exactly one affected row. Commit only after these checks pass;
   otherwise roll back. An unchanged form performs no update.

The update invariant is `stored row = original row + explicitly changed fields`, with exact
string/NULL equality for every cell. Parsing must also satisfy `output(input(text)) = text` for
each changed value. Tests exercise these conditions; the transaction enforces them on every write.

For example, `numeric(5,2)` rejects `1.234` rather than saving `1.23`. A boolean uses `t` or `f`, as
returned by PostgreSQL. JSONB must use PostgreSQL's canonical representation; a rejected spelling
can be corrected explicitly. Textual JSON retains its original whitespace and numeric precision.

Supported built-in types are listed in [`catalog.ts`](src/admin/database/catalog.ts); their arrays
and enum labels are supported too. Unknown codecs, domains, composites and unsupported relation
behavior are read-only. Views are listed after the tables of their schema under a heading of their
own (`kind: 'view'`) and read like one — filters, sorting, visibility, copying — but never written; having
neither key nor `ctid`, a view's rows come in its own order unless a sort is chosen. Materialized
views are not listed: `information_schema` does not describe their columns. Foreign-key restrictions
can disable deletion while permitting edits. The server checks these restrictions again when saving.

These guarantees concern the editor's value transport and row operations. PostgreSQL and the schema's
built-in constraints/default expressions are trusted; schema authors remain responsible for their
effects. User-defined routines, triggers and operators require separate support before editing is
enabled. Defaults are applied only when explicitly selected or supplied by a generated column.

Columns the database numbers itself — `IDENTITY`, `serial`/`bigserial` and any default whose
expression calls `nextval(...)`, wrapped in arithmetic or not — are never written by the editor. A new row leaves them out so PostgreSQL assigns the value, the
screen shows them locked with that explanation, and the server refuses a supplied value (including
SQL NULL) on insert and any change on update, even when the column is not part of the primary key.
PostgreSQL itself would accept a hand-typed number, but the sequence would not advance and the next
automatic row would collide with it; a deliberate manual number belongs in `psql`, not here.

The editor reaches Admin's own `administrators` table without the registry screen, so the screen's
rule is asked again there. The screen shows a notice above that table and in its row dialog, and the
table stays editable. After an update or delete of that table, and before the commit, the remaining
enabled owners are checked with Auth through the same helper the screen uses: at least one must be
an identity Auth knows and has not blocked, or the write is rolled back. Counting rows would not do:
a `user_id` pointing at nobody, or a row inserted by hand, looks like an owner and lets nobody in.
Auth is asked while the table lock is held, as the registry procedures already do. Deleting an
administrator row is refused anyway, because grants cascade from it.
The same owner can be locked out through Auth's `identities` table: blocking the account, replacing
its password hash or its e-mail. The editor knows that table only by Auth's module id and its key,
not by its columns, so the rule is drawn around the row: the account of an enabled owner is not
changed or deleted here unless another owner can still sign in, as Auth answers before the write.
Asking Auth after the write would not do, because Auth reads committed rows and would not see the
transaction. The editor takes the registry table's lock first — before the identity's table and row —
in the mode it uses for its own writes, which conflicts with the registry screen's lock and with editor
writes to `administrators`: disabling an owner there and blocking one here are serialized, not raced.
The order matters: the screen locks the registry and then has Auth update the identity row, so the
editor must lock in the same order. Row first would leave the editor holding the row while waiting for
the registry, the screen holding the registry while waiting for Auth, and Auth waiting for the row — a
cycle PostgreSQL cannot detect, because the screen's wait happens in the application.
The screen shows a notice above `auth.identities` as well.
[`registry.postgres.test.ts`](src/admin/database/registry.postgres.test.ts) builds the real `admin`
schema from the module's migration in the test database, a stand-in `auth.identities` with Auth's
schema, table and key names, and steers a stub Auth through these cases, including the lock wait.

To add a type, establish that its PostgreSQL text representation and accepted edits preserve values,
then add real insert/update/delete and unchanged-neighbor checks to
[`types.postgres.test.ts`](src/admin/database/types.postgres.test.ts). Include boundary values, SQL NULL,
type modifiers and any normalization that must be refused. The catalogue inventory test requires an
explicit decision for every built-in type, including read-only types. Browser tests cover the path
from the original cell through the form to the stored value.

## Configuration and data

[`AdminEnv`](src/env.ts) receives `databaseUrl`, `sessionCookieName`, `csrfCookieName` and
`publicOrigin`. Session settings must match Auth so logout clears the same cookie.

Schema `admin` stores `administrators`, `administrator_grants` and `admin_audit`.
Administrator records refer to Auth identity IDs; identity lookups use Auth's API. Schema changes
belong in [`src/db/migrations/`](src/db/migrations), following the
[migration instructions](../../docs/development.md#migrations).

## Tests

Run `pnpm --filter @template/admin test` for unit tests.

Database editing tests exercise the module directly with their own PostgreSQL pools.
Use a PostgreSQL 17 test database, matching CI, and pass `DATABASE_URL` in the process environment:

```bash
DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/admin_tests' \
  pnpm --filter @template/admin test:database
```

The database account needs `CREATE` on the database for test schemas. The two
[column-visibility checks](src/admin/database/column-visibility.postgres.test.ts) also require
`CREATEROLE`; Vitest reports them as skipped when it is unavailable. Tests remove their schemas
and roles after execution.

See the [development guide](../../docs/development.md#checks) for application and browser checks.
