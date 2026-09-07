# gateway

The entry for traffic. The composer mounts Gateway, and only Gateway, on the public listener, so
every request from outside reaches it before it reaches anything else.

It is not the entry of the *program* — that is the root `index.ts`, which starts first and builds
everything — and it stays a module rather than becoming the composer. The composer has to know every
module; Gateway holds the access policy. Together they would be the widest permission in the
repository handed to the narrowest job.

It has no database and contains no product business logic.

## Routing

The path is never rewritten — a module receives exactly the address the browser asked for. Routing
has always gone by path, and a module in this process reads the path off the very same `Request`.

| Incoming path | Target | Gateway check |
| --- | --- | --- |
| `/admin/embed/service/:name/**` | admin surface of that module | session, admin role, grant on `:name` |
| `/admin/embed/database/**` | the panel's database interface, handed in as its own target | session and the `owner` role |
| `/admin/**` | `admin` | session and an admin role |
| `/service/:name/**` | module from the public allowlist | none — the module secures itself |
| `/app/**` | `app` | none — App verifies the user session itself |
| everything else | `site` | none — public |

`:name` is never turned into a target by itself. It is only ever looked up in the explicit allowlists in
[`src/registry.ts`](src/registry.ts):

- **public** — `auth`, `users`;
- **admin** — `auth`, `users`, `notifications`, `email`.

An unknown name has no entry, so nothing is proxied and Admin is not even asked about it — the answer
is 404.

The database section is in neither list, and not because it was forgotten: it is not a module of this
template, and it reads every module's data at once. So it has no `:name` and no grant can name it —
it is reached only by its own path above, which the owner alone passes. Behind that path is
`pg-interface`, a target like any other in this process: named on its own in `GatewayTargets`, reached
after the check and never instead of it.

`scripts/check-service-ids.mjs` reconciles these lists with `shared/src/vocabulary.ts` and the central
Admin shell, so a service can never be reachable here while being invisible in the shell — and it
rejects `database` in either list outright, for the reason just given.

## Admin authorization

Every `/admin/**` request — HTML, API and assets alike — passes the same check. There is no
separate public policy for admin assets.

The whole check is one internal Admin method, `admin.authorize`. Gateway computes nothing itself,
keeps no copy of the rights and caches no result, which is why a changed grant takes effect on the
very next request.

| Admin answer | Gateway |
| --- | --- |
| `allowed` | proxies and forwards the verified administrator context |
| `denied` | 403, regardless of the reason |
| `awaiting-first-user` | 403 explaining that nobody has registered yet |
| unreachable | **503**, fail-closed — an outage is never reported as "no rights" |

One more failure is not in that table because it is not an answer from Admin: if the target itself
does not answer, the reply is **502**. Worth keeping apart from the 503 above — 503 means the access
check could not be made, 502 means it was made and passed, and then the service behind it went
missing.

### The administrator context is a trust boundary

Before deciding anything, Gateway deletes every `x-template-admin-*` and `x-template-request-id`
header from the incoming request — on **all** routes, including public ones. A browser can therefore
never forge an administrator context, and a service can trust the headers precisely because only
Gateway can reach it.

What comes back is not symmetrical. The three `x-template-admin-*` headers are written again only
from a verified `allowed` result. `x-template-request-id` is written on **every** route, from
Gateway's own id for the request — a public service still gets one to log, it just can never be the
value the client sent.

### Every refusal comes in the caller's own format

An error from Gateway itself — 403, 404, 502, 503 — is an HTML page when the request's `accept`
mentions `text/html`, and otherwise `{ "error": …, "message": … }` as JSON. Both are always
`cache-control: no-store`. That is why a browser gets a readable page and an API client gets a code
it can branch on, from the same refusal.

## Responses and encoding

Forwarding rewrites a small, fixed set of headers. `host` is dropped, and `x-forwarded-host` and
`x-forwarded-proto` are set from the address the browser actually asked for. `x-forwarded-for` is
neither set nor removed: Gateway does not know the real client address, and a module must not learn
it from here — that is the edge proxy's job, which is also why the attempt counter in `shared` limits
per account rather than per address.

The proxy runtime decodes compressed responses transparently, so Gateway asks upstream for
`accept-encoding: identity` and removes `content-encoding` and `content-length` from what it
forwards — those headers would otherwise no longer describe the body. Hop-by-hop headers are
dropped in both directions.

Upstream redirects are passed through untouched (`redirect: 'manual'`), because a service's own
redirect belongs to the browser — together with any cookie that redirect sets.

## Environment

| Variable | Purpose |
| --- | --- |
| `PROJECT_SLUG` | Session cookie name Gateway reads to find the session token |
| `PUBLIC_SITE_URL` | External origin, used in the sign-in link of the 403 page |

Gateway holds no addresses at all: the composer builds every module and hands the whole set over as
`targets`, and every target is an application in this process. The database browser, which ran beside
the application and answered over the network, was the last real address anywhere — it is gone, and
nothing in the process dials outwards.

A module calling a neighbour takes no address either: it is handed a caller built from the
neighbour's own router and invokes a procedure on it, so there is no request and nothing to dial.

The port itself is not Gateway's either: the entry reads it and opens the listener. Locally it comes
from `GATEWAY_PORT` in `.env`, so two worktrees can run at once; in production `PORT` takes
precedence, because that is what a hosting platform sets.

## Commands

```bash
pnpm --filter @template/gateway test
```
