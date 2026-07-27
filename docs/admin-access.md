# Administrator access

Who may open the admin panel, what they may reach inside it, and how the first one comes to exist.

## Being an administrator is a separate fact

An account in Auth is how someone signs in. An administrator record in Admin is permission to open
the panel. They are different things, deliberately:

- adding an administrator does not create an account — the person must already have one;
- removing administrator access does not touch their account;
- the administrator list is not "all users"; it holds only people who were explicitly added.

## Two roles

| | Owner | Admin |
| --- | --- | --- |
| The admin panel | yes | yes |
| Service admins | all of them | only what was granted |
| The database area | yes | **never** |
| Managing administrators | yes | no |
| The audit log | yes | no |

An ordinary administrator sees only the services they were granted. That filtering is presentation:
the protected URL of a hidden service passes the very same Gateway check, and Gateway refuses it.

## The database is a section of the panel, not a service

Every service admin is one service's own window onto its own data. The database browser is not that:
it reads every service's data at once, so calling it a service admin would have been calling it
something it is not.

It is therefore an **area** of the panel, at `/admin/database/`, next to the administrator registry
and the audit log. Nothing in the system calls it a service:

- it is absent from `ADMIN_SERVICE_IDS`, so no grant can name it and none ever could;
- Gateway asks Admin about a **target** — `panel`, `service` or `database` — rather than about a
  service name that might be one of those things or might not;
- the sidebar shows it under Owner, because that is who it belongs to.

The application behind it is still Adminer, still a container of its own, still reached only through
Gateway with no host port anywhere. What changed is what the system calls it.

## The first owner

On a fresh installation nobody is an administrator and nobody can add one. The rule that resolves
this: **the first account registered in Auth becomes the owner**, the first time someone opens the
admin panel.

Ownership follows registration order in Auth, not who reached the panel first. If a second person
opens it before the first one does, the first Auth account still becomes owner and that request is
refused.

The bootstrap runs inside a transaction that takes a lock, so two requests arriving together produce
one owner and one audit entry, not two of either. If Auth has no accounts at all, the panel reports
that it is waiting for the first user rather than promoting whoever knocked.

## Grants take effect immediately

Gateway asks Admin on every request and caches nothing. Changing a role, revoking a grant or
disabling an administrator closes the door on their next request — they do not have to sign out, and
there is no window where a stale decision still applies.

## The last owner

The last active owner can neither be demoted nor disabled. A project that could lock itself out of
its own admin panel would need database access to recover, which is the thing the panel guards.

An owner can promote a second owner and then step down — the rule only refuses to leave zero.

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
Blocking prevents signing in and is reversible. An owner cannot block their own identity.
