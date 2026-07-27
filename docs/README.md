# Documentation

A working product with its boring parts already done. This is what it is made of and why it is
made that way.

## Start here

| | |
| --- | --- |
| [Architecture](architecture.md) | The services, what each owns, and why they are split like that |
| [The admin panel](admin-panel.md) | What is inside it, how it is composed, how to extend it |
| [Administrator access](admin-access.md) | Roles, grants, the first owner |
| [Local development](local-development.md) | Running it, worktrees, the checks |
| [Deployment](deployment.md) | What a deployment supplies, and what it must not |

Each service has a README beside its code, describing what only that service knows:
[gateway](../services/gateway/README.md), [site](../services/site/README.md),
[app](../services/app/README.md), [admin](../services/admin/README.md),
[auth](../services/auth/README.md), [users](../services/users/README.md),
[notifications](../services/notifications/README.md), [email](../services/email/README.md).

The [acceptance tests](../tests/README.md) describe what is verified against a running stack.

## What this template decides for you

A template is only useful where it has taken a position. These are the positions, each with the
reason, so a project can disagree with one on purpose rather than by accident.

**One way in.** Only Gateway is published. Every other service lives on the internal network with
no host port, in every environment. A service that could be reached directly would make Gateway's
checks optional.

**Each service owns its data.** One database per service, no cross-reads, no foreign keys across
them. Anything else and two services can never be changed or replaced independently, which is the
only reason to have two.

**Identity and profile are different things.** Auth owns how someone signs in; Users owns who they
are inside the product. A product changes its profile fields constantly and its sign-in almost
never — joining them means every profile change touches the thing that guards accounts.

**Being an administrator is a separate record.** Not a flag on an account. Granting admin access
does not create a user and removing it does not touch one.

**The panel is composed, not merged.** Each service admin is its own build, embedded in the shell
over a small `postMessage` protocol. The shell never imports their code, so a service can change
its admin without rebuilding the panel.

**Nothing is decided by the interface.** Hiding a menu entry is presentation; the server refuses the
same request either way, and every check is a real HTTP request through Gateway in the tests.

**Email is stored, not re-rendered.** Publishing produces the HTML and text; delivery sends exactly
that. A library upgrade cannot change a message someone already approved.

**One language.** Several are a real feature, but which language to send in depends on what a
product knows about a person — a guess here would be unpicked by every project.

**Small on purpose.** The profile is a display name. The event list is five auth events. Where the
template could only have guessed, it stops and leaves the decision where it belongs.
