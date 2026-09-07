# Documentation

A working product with its boring parts already done. This is what it is made of and why it is
made that way.

## Start here

| | |
| --- | --- |
| [Architecture](architecture.md) | The modules, what each owns, and why they are split like that |
| [The admin panel](admin-panel.md) | What is inside it, how it is composed, how to extend it |
| [Administrator access](admin-access.md) | Roles, grants, the first owner |
| [Local development](local-development.md) | Running it, worktrees, the checks |

Each module has a README beside its code, describing what only that module knows:
[gateway](../modules/gateway/README.md), [site](../modules/site/README.md),
[app](../modules/app/README.md), [admin](../modules/admin/README.md),
[auth](../modules/auth/README.md), [users](../modules/users/README.md),
[notifications](../modules/notifications/README.md), [email](../modules/email/README.md).

Four more documents sit outside `modules/`: [the composer](composer.md) — the root `index.ts`, which
builds every module and wires them together; [shared](../shared/README.md), the toolbox every module
may use and where adding a procedure is explained; the [acceptance tests](../tests/README.md), which
describe what is verified against a running application; and
[the database interface](../pg-interface/README.md), the panel's own database section — a package that
imports nothing of this repository, so that it stays independent of it.

## What this template decides for you

A template is only useful where it has taken a position. These are the positions, each with the
reason, so a project can disagree with one on purpose rather than by accident.

**One way in.** Gateway is the only application on the public listener: the process opens exactly one
port, and whatever terminates TLS in front of it is outside this repository. Nothing else is reachable
from outside — a module that could be reached directly would make Gateway's checks optional.

**Modules, in one process.** Eight of them, each its own package, and a database of its own for the
five that store anything, talking to each other through contracts. The point of the contracts is not
that a module could be moved out again — it is that a module cannot learn anything about a neighbour
beyond what the contract says, whoever is editing it. What one process costs is isolation of failure,
and that is the price this template chose to pay.

**Each module owns its data, and reaches nobody else's.** A neighbour's table lives in another
database, so a query would need another connection rather than another table name. What refuses it is
the module's own check on the pool it opened — the one account this template uses opens every
database, so PostgreSQL does not refuse anything here. Every other boundary is about code, and no
check that reads code can read a query.

**Identity and profile are different things.** Auth owns how someone signs in; Users owns who they
are inside the product. A product changes its profile fields constantly and its sign-in almost
never — joining them means every profile change touches the thing that guards accounts.

**Being an administrator is a separate record.** Not a flag on an account. Granting admin access
does not create a user and removing it does not touch one.

**The panel is composed, not merged.** Each module's admin is its own build, embedded in the shell
over a small `postMessage` protocol. The shell never imports their code, so a module can change its
admin without rebuilding the panel.

**Nothing is decided by the interface.** Hiding a menu entry is presentation; the server refuses the
same request either way, and the tests ask over HTTP through Gateway rather than by calling a router —
the one exception speaks to PostgreSQL, because which databases exist is not something an answer over
HTTP would show.

**Email is stored, not re-rendered.** Publishing produces the HTML and text; delivery fills in the
values that are only known per recipient and sends that, without ever calling the renderer again. A
library upgrade cannot change a message someone already approved.

**One language.** Several are a real feature, but which language to send in depends on what a
product knows about a person — a guess here would be unpicked by every project.

**Small on purpose.** The profile is a display name. The event list is five auth events. Where the
template could only have guessed, it stops and leaves the decision where it belongs.
