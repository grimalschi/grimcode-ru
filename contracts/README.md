# Module contracts

`@template/contracts` contains the types used to connect modules. Providers and consumers share
these declarations; validation and implementation belong to the provider. Use interfaces, type
aliases, `import type` and `export type` so contracts add no runtime code. Check this in review;
ESLint requires modules to import these declarations with `import type` or `export type`.

| Entry | Defines |
| --- | --- |
| [`module-instance`](src/module-instance.ts) | The result of a module factory |
| [`modules/`](src/modules) | Named APIs and exchanged data types |

## Module instance

A factory captures its `env` settings and dependency APIs in `modules`, then returns the capabilities
it provides:

```ts
import type { ModuleInstance } from '@template/contracts/module-instance';

return {
  id: 'example',
  publicFetch,
  adminFetch,
  internalCaller,
  admin: { title: 'Example', icon: 'box' },
  migrate,
} satisfies ModuleInstance<ExampleApi>;
```

| Field | Purpose |
| --- | --- |
| `id` | Stable module identifier |
| `publicFetch(request)` | Public HTTP handler |
| `adminFetch(request)` | Separate administrative HTTP handler |
| `internalCaller` | Ready tRPC caller implementing `Api` |
| `admin: { title, icon, assignable? }` | Embedded screen metadata; `icon` is a [Lucide ID](https://lucide.dev/icons/), such as `mail`; `assignable: false` restricts access to owners |
| `migrate()` | Storage preparation at startup |

Only `id` is required. Omit unused capabilities and factory inputs. HTTP handlers take a `Request`
and return a `Response` or `Promise<Response>`. Use `satisfies` and leave the return type inferred:
composition then knows which handlers the module actually provides.

## Connecting an API

Declare an API once under `src/modules/`. The provider implements it; the consumer imports it with
`import type` and names it in its factory input. For example, Notifications accepts
`modules: { email: EmailApi }` from the [Email contract](src/modules/email.ts).

Composition supplies the ready caller:

```ts
const email = createEmail({ env: emailEnv });
const notifications = createNotifications({
  env: notificationsEnv,
  modules: { email: email.internalCaller },
});
```

Notifications calls `modules.email.send(input)`. The provider creates the caller and its private
context. Call deadlines, where used, are documented by the provider; they do not cancel underlying work.

Use function properties such as `send: (input) => Promise<Result>` for API operations. This lets
strict type checking reject an implementation that accepts fewer inputs than its contract.

## Browser clients

A module's own browser imports its router type from its server using relative `import type`.
Cross-module browser clients use the public contracts here: App consumes `AuthPublicRouter` and
`UsersPublicRouter`.

Public contracts use native tRPC router and procedure types. Providers check their procedure record
and router with `satisfies`, plus input equality with `inferRouterInputs`: router assignability alone
can permit narrower inputs. See the [Auth public router](../modules/auth/src/public/router.ts) for
these checks. Runtime `.input()` and `.output()` validation stays in the module.
