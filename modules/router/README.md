# Router

Router receives external HTTP requests, checks administrative access and calls the module handlers
supplied by composition. The application's HTTP listener uses its `publicFetch`.

## Integration

```ts
createModule({
  env,
  modules: { admin: admin.internalCaller },
  publicFetches: { web: web.publicFetch, auth: auth.publicFetch },
  adminFetches: { admin: admin.adminFetch, auth: auth.adminFetch },
});
```

[`RouterOptions`](src/registry.ts) requires Web in `publicFetches`, Admin in `adminFetches`
and Admin's internal API in `modules`. Additional entries publish modules at their respective prefixes.
`env` contains `sessionCookieName` and `publicOrigin`; the origin supplies the sign-in link on
access-denied pages.

## Routing

Handlers receive the original request URL.

| Incoming path | Target | Access check |
| --- | --- | --- |
| `/healthz` | Router health response | Public |
| `/admin/embed/module/:name/**` | Module's `adminFetch` | Administrator role and module grant |
| `/admin/**` | Admin's `adminFetch` | Administrator role |
| `/module/:name/**` | Module's `publicFetch` | Receiving module |
| Everything else, including `/app/**` | Web's `publicFetch` | Receiving API modules |

Only explicitly registered map entries are routed. Unknown names and unsupported `/admin/embed/`
paths return 404. `web`, `admin` and `router` are reserved for dedicated routes and rejected
under both module prefixes.

## Administrative authorization

Every routed administrative request, including assets, calls
`modules.admin.authorize({ sessionToken, target })`. The token comes from `sessionCookieName`;
the target identifies the panel or an embedded module. Each request uses a fresh decision so role
and grant changes take effect immediately on subsequent requests. Admin procedures enforce their
own [owner checks](../admin/README.md#authorization-and-roles).

| Result | Response |
| --- | --- |
| Allowed | Call `adminFetch(request, adminContext)` with the verified administrator |
| Denied | 403 |
| Empty installation awaiting registration | 403 with a registration prompt |
| Authorization call fails | 503 |
| Target handler fails | 502 |

A denied or failed authorization leaves the target uncalled. Router errors use HTML for requests
accepting `text/html`, otherwise JSON `{ error, message }`, and carry `Cache-Control: no-store`.

Router creates `adminContext` from the allowed result: `{ userId, email, role }`.
The context is a typed argument of the module handler, scoped to this request.
Administrative handlers are reachable externally through Router, which owns the access check.
Modules receive settings and context through the [HTTP contract](../../contracts/README.md#http-context).

## Forwarding

[`src/proxy.ts`](src/proxy.ts) calls handlers in the same process. It preserves bodies, status,
redirects and cookies, and removes hop-by-hop headers and content lengths. The outer HTTP server owns connection framing. `x-forwarded-for` is passed through, so authentication of client addresses
belongs to the edge proxy.

Run `pnpm --filter @template/router test` for module checks. See
[development guide](../../docs/development.md#checks) for running and testing the application.
