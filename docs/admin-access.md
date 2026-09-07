*[Documentation](README.md) → Administrator access*

# Administrator access

Who may open the admin panel, what they may reach inside it, and how the first one comes to exist.

## Being an administrator is a separate fact

An account in Auth is how someone signs in. An administrator record in Admin is permission to open
the panel. They are different things, deliberately:

- adding an administrator does not create an account — the person must already have one;
- removing administrator access does not touch their account;
- the administrator list is not "all users": it holds the people an owner added by hand, plus the one
  row the first-owner bootstrap writes by itself.

## Two roles

| | Owner | Admin |
| --- | --- | --- |
| The admin panel | yes | yes |
| Service admins | all of them | only what was granted |
| The database area | yes | **never** |
| Managing administrators | yes | no |
| The panel's own audit log | yes | no |

A service's own log is a different thing and follows its grant: an administrator who may open the Auth
admin reads Auth's security log there.

An ordinary administrator sees only the services they were granted. That filtering is presentation:
the protected URL of a hidden service goes through the very same Gateway check, which refuses it.

## The database is a section of the panel, not a service

Every service admin is one service's own window onto its own data. The database interface is not that:
it reads every service's data at once, so calling it a service admin would have been calling it
something it is not.

It is therefore a **section** of the panel, at `/admin/database`, next to the administrator registry
and the audit log. Nothing in the system calls it a service:

- it is absent from `ASSIGNABLE_SERVICE_IDS`, which is what every grant is validated against, and
  from `ADMIN_SERVICE_IDS` as well — and `check-service-ids.mjs` refuses a build where `database`
  appears in either of them, or in Gateway's public allowlist;
- Gateway asks Admin about a **target** — `panel`, `service` or `database` — rather than about a
  service name that might be one of those things or might not;
- the sidebar shows it under «Админка», with the panel's own sections.

Behind it is this template's own interface, [`pg-interface`](../pg-interface/README.md) — the tables of
each module's database, a page of rows with filters and sorting, and adding, changing or removing one
row.

It can also add a column, and rename or drop one **it added itself**. Columns that came from a module's
migration are read and filled, never renamed or dropped: the module's code names them, and a rename
would break it with the next request. Tables are not created here at all. Every change of shape is
written into the project as a migration of that module, so it is committed like any other change and
arrives at every other copy through git — and so a copy running away from its sources offers no change
of shape at all.

It opens connections of its own rather than borrowing the modules' — two per database, on the first
request that looks at one — so a heavy query typed into the console cannot hold a connection the site
needs.

## The first owner

On a fresh installation nobody is an administrator and nobody can add one. The rule that resolves
this: **the first account registered in Auth becomes the owner**, the first time someone opens the
admin panel.

Ownership follows registration order in Auth, not who reached the panel first. If a second person
opens it before the first one does, the first Auth account still becomes owner and that request is
refused.

The bootstrap is a conditional insert inside a transaction, and what makes two requests arriving
together converge is a partial unique index — `administrators_single_bootstrap_idx`, over the
`bootstrap` flag — so the second insert does nothing, and only the request that really created the
row writes the audit entry. One owner and one entry, not two of either. If Auth has no accounts at
all, the panel reports that it is waiting for the first user rather than promoting whoever knocked —
and it says so to a visitor with nothing to sign in with, which on a fresh installation is everyone.

## Grants take effect immediately

Gateway asks Admin on every request and caches nothing. Changing a role, revoking a grant or
disabling an administrator closes the door on their next request — they do not have to sign out, and
there is no window where a stale decision still applies.

## The last owner

The last owner who can actually enter can neither be demoted nor disabled. A project that could lock
itself out of its own admin panel would need database access to recover, which is the thing the panel
guards.

An owner can promote a second owner and then step down — the rule only refuses to leave zero. This is
where the lock is: changing a role, the `enabled` flag or a set of grants holds the whole table
(`LOCK TABLE administrators IN SHARE ROW EXCLUSIVE MODE`) while it counts the owners who are left,
because two simultaneous requests each seeing one other owner would otherwise leave none. Adding an
administrator takes no lock and needs none: an insert cannot lower that count.

"Who can actually enter" is why blocking matters here. A blocked identity loses every session and
every token, so an owner blocked in Auth is enabled in the registry and still unable to sign in.
Admin therefore asks Auth which of the remaining owners are blocked before it counts them, and the
question runs before the transaction opens, so the table lock is not held while another module
answers.

Blocking itself asks nothing. Only an owner may block, and blocking yourself is refused outright, so
whoever blocks is an owner still able to sign in afterwards — blocking alone can never leave the panel
without one. The refusal a person meets is therefore in **Администраторы**, when the rights would come
off the last owner who can enter, and not in **Пользователи** when someone is blocked.

## What is recorded

Every change to administrator access is written to the audit log, including the automatic creation
of the first owner, which is recorded as done by the system rather than by a person. The question
"who gave them access" always has an answer.

The registry has no delete operation on purpose: removing the record of who once had access would
defeat the audit. An administrator who should no longer have access is disabled and stripped of
grants.

## Mutations carry a token

Every operation that changes something requires a CSRF token issued by the same surface it is sent
to. A request without one is refused, so a link from elsewhere cannot make an administrator's
browser act on their behalf.

## What the panel cannot do

The Auth service admin deliberately offers no way to read or set anyone's password. What it offers
is the ordinary flow a person would go through themselves: a recovery link, which is time-limited,
works once, and whose token is never shown to the administrator who sent it.

An administrator can sign someone out everywhere and — if they are the owner — block an account.
Blocking prevents signing in and is reversible.
