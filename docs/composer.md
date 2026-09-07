*[Documentation](README.md) → The composer*

# The composer

[`index.ts`](../index.ts) at the root of the repository: the entry of the program, and the only file
that knows every module.

It reads the environment, builds each module, hands out what each one needs — its own environment and
a way to reach the neighbours it calls — mounts Gateway on the port and listens. That is the whole of
it. Databases it does not open: each module creates and opens its own.

It was a package of its own, `composition/`, until 21 August 2026. Being a package bought one real
thing — `pnpm deploy --prod` cut the runtime dependency tree to exactly this entry point when the
container image was built — and when the image went, so did the reason.

## Nothing in the wiring is a decision

`compose()` is the order of calls and nothing else: no routing, no policy, no defaults, no "if this
is missing then that".

It does refuse to start in one place, and a refusal is not a decision — there is no second branch to
take: `assertDistinctDatabases` stops the program when `PROJECT_SLUG` is long enough that two modules
would end up sharing one database name after PostgreSQL cuts it. That is a property of the names this
file hands out, which is why it is checked here and not in a module.

Whether a module opened the database it was given is that module's own check, on the pool it opened
itself — `assertOpenedDatabase`, beside the driver.

This is the one **file** with permission to import every package — `workspace-rules.mjs` grants it
explicitly, by name, and both boundary checks read that grant from there. The permission is affordable
exactly while the rule above holds. The day a decision moves in here, this becomes the place where
decisions are made with the widest access in the repository, and the point of the boundaries is gone.

Naming the file rather than the root is deliberate: `.` is the compartment anything unmatched falls
back to, so granting the permission to the root would hand it to every directory nobody has written a
rule for yet.

Where a decision belongs instead: routing in `gateway`, product rules in the module that owns the
data, anything shared and mechanical in `shared`.

## Only Gateway is mounted, and only here is a port opened

Mounting anything else on that listener out of convenience — `app.route('/', authApp)` — would put
the internal surfaces on the public port and let the panel's own admin shadow the four embedded ones.
No error, no failing build, just a boundary that is gone.

The port itself is the other half of the same rule: `@hono/node-server` — the bare specifier, the one
that exports `serve` — may be imported by this file and nowhere else, and `check-boundaries.mjs`
refuses it anywhere else. It matters more now than it did when this was a package: the root's
`node_modules` is on every package's lookup path, so a dependency declared in the root manifest is
resolvable from every file in the repository.

Why the entry of the program and the entry for traffic are different things is in
[architecture](architecture.md).

## The calls between modules

A module that has an internal surface hands out a **caller** built from its own router, and this file
is what passes it on: `callEmail: (called) => email.internalCaller(emailEnv, called)`. The neighbour
receives a function of one argument — the request the call belongs to — and the environment is closed
over here, because a direct call has no request to carry it.

Two things follow, and both are easy to miss:

- **the deadline belongs to the module that hands the caller out**, not to the call site.
  `withDeadlineOn` puts it on every procedure of the caller, so no caller has to remember it. It stops
  the caller waiting; it cannot stop the handler running;
- **`call(name)` is still a lookup at request time.** Gateway's targets are built before the map of
  applications exists, so the closure finds the application when a request arrives rather than when it
  is made — calling one while the map is being built would read `undefined`, with the types right and
  an error that says only that.

The calls run in one direction: Gateway asks Admin, Admin and Users ask Auth, Auth asks Notifications,
Notifications asks Email. Nothing asks back, so the modules are built in dependency order and the map
of applications is one expression.

## The environment is read here and left in place

Everything a module gets out of the environment is read in `compose()` and handed over as a value: the
mail settings, the session lifetime, and for a module with a database three strings — the database it
works in, the name it must land on, and the server connection for the one `CREATE DATABASE`. A module
reads nothing itself, which the lint rules and `check-boundaries` enforce.

The third of those is derived from the module's own string rather than from `DATABASE_URL`, which is
what lets `DATABASE_URL_<MODULE>` point a module at another server: taken from `DATABASE_URL` it
created the database on the default server and then failed to connect to the one it was given.

What used to be here as well was deletion: every credential removed from `process.env` once handed
out, so that one process did not leave a neighbour's password readable. That went, deliberately. It
bought less than it looked like — the connection string lives on `c.env` for the life of the process
either way, and `/proc/<pid>/environ` keeps the startup snapshot regardless — and it cost a reader
that remembered every name it read, plus a list of variables it must never be given because they are
read after `compose()` returns or again on every request.

So `DATABASE_URL` and the mail key stay readable through `process.env` for anything inside the
process, dependencies included. That is the standard exposure of a Node application, now accepted
here too.

## Building and running it

One file, importable and runnable: the listener at the bottom starts only when this file is the
program, so its own tests and the acceptance suite can import `compose` without opening a port.

```bash
pnpm build   # turbo builds every package, then tsc builds this file into dist/
pnpm dev     # the same, and then runs it
```

It is built by `tsc -b tsconfig.entry.json` rather than by turbo, and that is not a preference: a
turbo task named `build` on the root package would run the root's own `build` script, which is the
turbo wrapper, and turbo would call itself. Its own tests run under the root `vitest.config.ts`, which
collects `index.test.ts` and nothing else — without that, vitest at the root would walk the whole
repository and run every package's tests a second time.
