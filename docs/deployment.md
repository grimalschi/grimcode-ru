# Deployment

What a deployment supplies, what it must not, and what happens on the way up.

## What a person actually decides

Two things: the **domain** and the **database**. Everything else is fixed in the images.

| | Where it comes from |
| --- | --- |
| Internal ports of Gateway and the services | Fixed in the images and Compose. Nobody sets them. |
| The public port | There is none. The platform routes the domain to Gateway's internal port. |
| PostgreSQL | A managed resource, reached through `DATABASE_URL`. |
| Per-service databases | Created on first deploy as `<PROJECT_SLUG>_<service>`. |

Copy [`docker/.env.production.example`](../docker/.env.production.example) and fill it in:

| Variable | |
| --- | --- |
| `PROJECT_SLUG` | Names the Compose project and the databases. Changing it points every service at a different database. |
| `PUBLIC_SITE_URL` | The public origin as a visitor sees it. Links in email are built from it, and it decides whether the session cookie is marked `Secure`. |
| `DATABASE_URL` | The managed database. |
| `EMAIL_FROM_ADDRESS` | Who messages come from. |

None of these has a working default. A value that is wrong in production is worse than a run that
refuses to start, so Compose fails on a missing one.

```bash
docker compose --env-file .env.production -f docker/compose.production.yaml up -d --build
```

## What is exposed

Only Gateway, and only to the platform. No service publishes a host port in production —
`scripts/check-compose.mjs` refuses a configuration where one does.

Adminer is in production, on the internal network, reachable exclusively through Gateway's
owner-only route. It never gets a host port in any environment.

## What happens on start

1. `db-init` creates any missing service database. It is safe on every later deploy: it only adds
   what is absent.
2. Each service applies its own versioned migrations, in order, recording what it applied. A service
   that is already up to date does nothing.
3. Email creates the seed templates that are missing and leaves existing ones alone, so wording a
   project has edited survives a deploy.
4. The first person to register becomes the owner of the admin panel — see
   [administrator access](admin-access.md).

## Email will not send until it is told to

`EMAIL_PROVIDER` defaults to `log` even in production: messages are rendered, recorded in the
delivery log, and go nowhere. That is deliberate — a half-configured transport should not mail real
people.

Set `EMAIL_PROVIDER=unisender` with `UNISENDER_GO_API_KEY` to send through UniSender Go, the one
ready production transport. Another provider is an ordinary code change behind a small interface,
not a configuration matrix.

## Sessions and cookies

The session cookie is `HttpOnly` and `SameSite=Lax`, and is marked `Secure` when `PUBLIC_SITE_URL`
is `https`. That follows the origin rather than an environment name, because the same production
images also run locally over plain http, where a `Secure` cookie would never come back.

`AUTH_SESSION_TTL_SECONDS` is thirty days by default.

## Building images

One Dockerfile, built once per service with `--build-arg SERVICE=<name>`. Each runtime image
contains only that service's dependency closure — `pnpm deploy --prod` — so a service image holds no
neighbouring service and no build tooling. Build stages and cache are shared; the runtime images are
not.

## Upgrading

Migrations are forward-only and versioned. Deploy the new images; each service brings its own schema
up on start. There is no separate migration step to remember and nothing to run by hand.

A rollback is a matter for the change itself: a migration that dropped something cannot be undone by
starting an older image.
