# contracts

oRPC contracts and Zod runtime schemas for every inter-service call of the template.

This package holds **no** server implementation, SQL or provider secrets. It is the only thing a
service is allowed to share with another service: direct imports between `services/*` are
forbidden, and cross-service communication goes through HTTP/oRPC using these contracts.

## Layout

| File | Contents |
| --- | --- |
| `src/common.ts` | Service ids, admin roles, pagination, the verified admin context schema |
| `src/auth.ts` | Identity, sessions, public auth flows, internal lookups, Auth service admin |
| `src/admin.ts` | Administrator registry, the single `authorize` method Gateway calls, audit |
| `src/users.ts` | Product profile, preferences, onboarding |
| `src/notifications.ts` | The closed set of typed events and their template routing |
| `src/email.ts` | Templates, versions, publish, preview, test send and the delivery log |

## Three surfaces per service

Every service contract is split by trust boundary, and each part is mounted on its own path:

- `public` — reachable through Gateway as `/service/<name>/rpc`. Gateway performs no authorization
  here; securing these endpoints is the service's own responsibility.
- `admin` — reachable as `/admin/embed/services/<name>/rpc` only after Gateway verified the session, the
  admin role and the grant on that service.
- `internal` — mounted on `/internal/rpc`, which Gateway never proxies, so it stays reachable only
  from inside the Docker network.

## Service ids

`SERVICE_IDS`, `ADMIN_SERVICE_IDS` and `ASSIGNABLE_SERVICE_IDS` are the canonical lists.
`ASSIGNABLE_SERVICE_IDS` deliberately excludes `adminer`: Adminer is always owner-only and can
never be granted to a regular administrator.

Gateway and the central Admin shell keep their **own** explicit declarations rather than deriving
ids at runtime. `scripts/check-service-ids.mjs` and the contract tests reconcile all three.

## Commands

```bash
pnpm --filter @template/contracts build
```

```bash
pnpm --filter @template/contracts test
```
