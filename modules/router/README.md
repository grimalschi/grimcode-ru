# Router

Router receives external HTTP requests, checks administrative access and calls the module handlers
supplied by composition. The application's HTTP listener uses its `publicFetch`.

## Integration

```ts
createModule({
  env,
  modules: { admin: admin.internalCaller },
  publicFetches: { site: site.publicFetch, app: app.publicFetch, auth: auth.publicFetch },
  adminFetches: { admin: admin.adminFetch, auth: auth.adminFetch },
});
```

[`RouterOptions`](src/registry.ts) requires Site and App in `publicFetches`, Admin in `adminFetches`
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
| `/app/**` | App's `publicFetch` | App |
| Everything else | Site's `publicFetch` | Site |

Only explicitly registered map entries are routed. Unknown names and unsupported `/admin/embed/`
paths return 404. `site`, `app`, `admin` and `router` are reserved for dedicated routes and rejected
under both module prefixes.

## Administrative authorization

Every routed administrative request, including assets, calls
`modules.admin.authorize({ sessionToken, target })`. The token comes from `sessionCookieName`;
the target identifies the panel or an embedded module. Each request uses a fresh decision so role
and grant changes take effect immediately on subsequent requests. Admin procedures enforce their
own [owner checks](../admin/README.md#authorization-and-roles).

| Result | Response |
| --- | --- |
| Allowed | Call the handler with verified administrator headers |
| Denied | 403 |
| Empty installation awaiting registration | 403 with a registration prompt |
| Authorization call fails | 503 |
| Target handler fails | 502 |

A denied or failed authorization leaves the target uncalled. Router errors use HTML for requests
accepting `text/html`, otherwise JSON `{ error, message }`, and carry `Cache-Control: no-store`.

## Trusted administrator headers

Router removes client-supplied copies of the following headers from every forwarded request.
Administrator fields are set from an allowed authorization result.

| Header | Module validation |
| --- | --- |
| `x-template-admin-user-id` | Auth identity UUID |
| `x-template-admin-email` | Valid email, at most 320 characters, normalized to lowercase |
| `x-template-admin-role` | `owner` or `admin` |

Modules validate this wire format locally against the `AdminContext` contract. It is trusted
because Router is the sole external entry point: administrative handlers must remain reachable
only through Router. The header implementation is in
[`src/http/admin-context.ts`](src/http/admin-context.ts).

## Forwarding

[`src/proxy.ts`](src/proxy.ts) calls handlers in the same process. It preserves bodies, status,
redirects and cookies, removes hop-by-hop headers and content lengths, The outer HTTP server owns connection framing. `x-forwarded-for` is passed through, so authentication of client addresses
belongs to the edge proxy.

Run `pnpm --filter @template/router test` for module checks. See
[development guide](../../docs/development.md#checks) for running and testing the application.
