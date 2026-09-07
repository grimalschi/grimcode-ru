# @grimcode/pg-interface

A database interface for PostgreSQL: the tables of a database, a page of rows with filters and
sorting, and adding, changing or removing one row.

It replaced the third-party console this project used to embed in its admin panel. What it does not
do is decide who may use it — whoever mounts it decides that, which is what lets it live inside an
application that already knows who is asking.

## Nothing of this repository is imported here

Not a style: the package stays independent on its own terms, and one import of a workspace package
would tie it to the repository forever. `check-boundaries.mjs` refuses one — the rule is
`{ area: 'pg-interface', mayUse: [] }` in `scripts/workspace-rules.mjs`.

Everything arrives as an argument:

```ts
const database = createDatabaseInterface({
  basePath: '/admin/embed/database',
  databases: [{ name: 'app_auth', connectionString: 'postgres://…/app_auth' }],
  // Optional: without it the shape of a table cannot be changed from the screen at all.
  writer: schemaWriter,
});

const response = await database.fetch(request);
```

`basePath` is where it is mounted, so it can tell its own paths from the rest of the URL. `fetch` is
the whole surface: a `Request` in, a `Response` out, which is what lets a router treat it as it
treats a module.

## Its own connections, and few of them

Two per database, opened on the first request that looks at one. Borrowing the application's pool
would be cheaper and would tie the console to the site: a heavy query typed in here would hold
connections a request needs, a transaction left open would hold a lock on a live table, and session
state — a `SET`, a temporary table — would return to the pool and reach whatever borrowed that
connection next.

`application_name` is `pg-interface`, so a query of this interface can be told from the application's
in `pg_stat_activity`.

## What keeps it from being a hole

The console it replaced was safe in a way this one cannot be: there, a person wrote the SQL and owned
it. Here the query is assembled from a request body, so five rules do that work instead.

**Identifiers are looked up, values are parameters.** Every table and column named by a request is
found in `information_schema` first; nothing else is ever interpolated. A value carrying `'; DROP
TABLE …` is a string that matches nothing — checked against a live database, not only in a test.

**Conditions are a closed list.** Text columns take `contains`, `starts-with` and their like; numbers
and dates take comparisons. Accepting a fragment of SQL instead would make every other rule here
decoration. A `%` a person typed is a literal `%`: the wildcards are added to the value, not to the
pattern.

**A row is addressed by its whole primary key.** The key comes from the catalogue, not from a column
called `id` — a table whose key is two columns exists in this very project. Half a key would match a
set of rows and change all of them, so it is refused; a table with no key at all can be read and not
changed. Key columns cannot be edited either: the row is addressed by them.

**A changing request must carry `x-pg-interface: 1`.** This is the package's own protection against a
request sent by another site: a cross-site form cannot add a header, and a cross-site `fetch` that
adds one is stopped by a preflight this package never answers — it sends no CORS headers at all. It
is deliberately its own guard rather than the host application's: a mechanical check that reads tRPC
procedures cannot see this package, whatever it does.

**Nothing is written anywhere.** These databases hold password hashes and session identifiers, and this
package has nowhere to leak them to: it takes no logger and writes no line of its own. A request that
fails fails for the person who sent it, which is what they see.

## How many rows a table has

The exact number, unless the table is too large to count. A list of tables must not cost a full scan of
a large table, so the planner's `reltuples` is read first — it is free — and it decides one thing only:
whether counting is cheap. Above 10 000 rows the estimate is what the list shows; at or below that the
rows are counted for real, and so are the tables the planner has no estimate for at all (`reltuples` is
**-1** until something analyses a table, which is most tables on a young installation).

Three signs, because these are three different statements:

| On screen | What it says |
| --- | --- |
| `42` | the count |
| `~25002` | the planner's estimate, which can be off in either direction |
| `>10000` | counting stopped at the limit, so there are at least this many |

Two things this got wrong before, in that order. Reading `-1` as zero told a person a table with rows
in it was empty. Then, with that fixed, the estimate was used whenever it existed — so a table
autovacuum had been past showed `~3` beside a plain `5`, and the tilde marked the wrong thing: not
"this number is big" but "this table has been analysed". The `>` is from the same round: a count that
stopped at the limit is a floor, and showing it as `~10000` read as "roughly ten thousand" when the
table held 25 000.

## The screen

`web/` is a Vue 3 application with element-plus, built by vite into `web/dist` and served by this
package itself — the server reads the files, because a package that depends on nothing cannot borrow a
static-file helper either. Two details are load-bearing:

- **`base: './'`** in the vite config. The host decides where this is mounted, so asset URLs are
  relative to the page; an absolute base would bake one project's path into the package;
- **the theme comes from the host** over `postMessage`, message type `template.admin.theme`, written
  to `data-theme` on the root element and mirrored to element-plus's `dark` class. The type and the
  convention are copied rather than imported — see `web/src/theme.ts`, which says what would break if
  one side renamed it.

What the screen shows: the databases it was handed, the tables of one of them with the key and how many
rows each holds, and a page of rows. A cell shows one line of its value; **hovering it shows the whole
value, clicking it copies the whole value** — a hash, a uuid or a json document does not fit a line,
and json is shown indented. The two gestures are split because one popover cannot do both: text inside
it cannot be selected with the mouse, because a popover that captured the pointer would cover the cells
under it. Per column: sort, filter, hide. Filters offer the conditions the server said that column
takes, joined with "and" or "or". A row opens in a dialog, where the key is read-only and everything
else is editable; only what actually changed is sent.

**A new row is asked for only what the database will not fill in.** A column it fills itself — an
identity, or one computed from others — is absent from the form, because a new row carrying it is
refused. A column with a default may be left empty, and then it is **left out of the statement**, so
the default applies rather than an empty value. A `not null` column with nothing to fall back on is
refused here, naming the column: `email has no default in public.identities, so a new row has to carry
a value`. The table that records what has been applied, `schema_migrations`, takes no new row at all.

**A date is picked, not typed.** `date` gets a calendar, `timestamptz` a calendar with a clock, and the
value carries the browser's own offset so a moment does not shift into the server's zone. Beside a
default of either type there is a switch for `now`, which a calendar cannot express: it reaches the
database as `now()` rather than as the moment the dialog was open.

**The word `null` typed into a field means empty.** A person reads `null` in a cell — this screen's own
way of showing an empty value — and writes it back; PostgreSQL then answered `invalid input syntax for
type uuid: "null"`, which explains its type system rather than the mistake. A uuid, a number, a date, a
boolean and a json document have no value spelled that way, so the word is read as empty. Text is the
exception: there `null` is an ordinary string and stays one.

**Dates are read as written.** The driver turns `date` and `timestamp` into a JavaScript `Date` — a
point on the timeline — and neither type is one: on a machine at +03:00 the stored date `2026-08-27`
arrived as `2026-08-26T21:00:00.000Z`, a day earlier than the table holds. This package reads both as
the text PostgreSQL sent. `timestamptz` is left to the driver, because that one really is a moment.

**The count beside a table name follows a row this screen added or removed.** Counted rather than asked
for again: the table list counts the rows of every table in the database, the most expensive read here.
An estimate or a stopped count is left alone — ±1 says nothing about a number that is already
approximate.

**A filter is asked only once it can be answered.** A condition appears with nothing typed in it, and
an empty value means "not finished", not "match the empty string" — sending it anyway made PostgreSQL
answer `invalid input syntax for type uuid: ""` for the act of adding a row to a form. The count on the
button is of filters actually being asked, so a half-filled one is visibly not one of them. Conditions
that ask about presence (`is-empty`, `is-not-empty`) need no value and are asked at once.

**A value the column cannot hold answers 400, not 500.** PostgreSQL error classes 22 and 23 — a value
the type refuses, a constraint the row breaks — are answers to what the request carried, so they read as
a refusal; the message is shown, because it names the type and not the row. Anything else is this side
failing and stays a 500.

**Named views are deliberately absent.** The interface this one is modelled on stores them on its
server; ours has nowhere to store them, because it creates no table of its own — so the current view
lives in the URL hash instead, which is what made named views worth having: a link somebody can send.

## Columns, and the line this interface does not cross

Columns can be added, renamed and dropped from the screen. Tables cannot: a table is created by a
module's migration, and a table created here would belong to nobody.

**Adding is open, renaming and dropping are not.** A new column is optional by default: the module's own
`INSERT` names the columns it knows, so a column it has never heard of has to be satisfied by being left
out. Filling its existing rows is a row edit, which goes through the parameterised path.

**A required column is allowed, and only with a default.** `NOT NULL` is safe exactly when something
else answers for the rows the module inserts, and a default is that something. It cannot be taken away
afterwards — the next insert would fail — so the screen says as much where it is chosen. The default is
the one value in this package that reaches SQL as text, written by type rather than passed through;
`uuid` is refused for it, because the only sensible default generates a value, and a generating default
makes PostgreSQL rewrite the whole table and its indexes.

Renaming and dropping are allowed **only on a column this interface added**. The rest come from a
module's migrations and its code reads them by name — renaming `email` would take Auth down with the next
request. Nothing in `information_schema` says who created a column, which is why the naming below is
load-bearing rather than a nicety.

`schema_migrations` is not reshaped at all: it records what has been applied, and a column added to it
would describe something that never happened. This interface writes into that record itself, so it
would also be reshaping the ground it stands on.

## A change of shape is a migration

Every change made here is written into the project as one more migration of the module whose database
it is — applied, recorded and written in a single transaction. From then on it travels the way every
other statement in this project travels: by git, applied by `runMigrations` on any database that has
not run it. A colleague who pulls the code gets the column without ever opening this screen.

That is what the whole path is for. A change kept only in the database it changed reaches nobody, and
there would be nothing to commit — the schema would have two sources of truth, and only one of them
would arrive at a fresh installation.

**Where the project cannot be written to, a shape cannot be changed.** A built copy running away from
its sources has nowhere to put the migration, so the screen offers no way to add, rename or drop a
column, and the server refuses if asked anyway. The alternative — writing into that one database — is
the thing being avoided.

**The order inside the transaction is the design.** The statement runs, the row goes into
`schema_migrations`, the file is written, and only then does it commit. Of the ways this can end
badly, the one left is a commit that fails after the file was written: a migration in the project that
this database has not run yet — which is exactly what a colleague's copy looks like, and is applied on
the next start.

**Who owns a column is read back from the names.** A change is recorded as
`interface-add-public-profiles-notes`, a rename as `interface-rename-public-profiles-notes-remarks`,
a drop as `interface-drop-public-profiles-remarks`; replaying those names over `schema_migrations`
gives the set of columns this interface may rename or drop. No table of its own is kept: the record
travels with the migration that carries the change, so ownership arrives with the column.

**The next version is the higher of two answers.** The project's files say what it holds, the database
says what it has actually run, and they are not always the same — a database keeps what was applied to
it after the branch under it changes. Taking the files' word alone answered `duplicate key value
violates unique constraint "schema_migrations_pkey"`; measured, and the reason both are asked.

## Commands

```bash
pnpm --filter @grimcode/pg-interface build
pnpm --filter @grimcode/pg-interface test
```

The tests run without a database: `connect` is an option so a test can hand in a pool of its own. That
is also their limit — a fake pool answers what it was taught, so it cannot tell a valid query from one
PostgreSQL would refuse.

What a real server checks instead: seventeen browser checks drive this screen against a live database
(`tests/browser/database.spec.ts`), and two acceptance checks confirm that only the owner reaches the
section and that a changing request without the header is refused. Neither covers the SQL of a filter
condition against every type — that was measured by hand, condition by condition, against the same
question written in plain SQL.
