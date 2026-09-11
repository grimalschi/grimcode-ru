# App

The product SPA at `/app/`: sign-in, registration, recovery, dashboard and account settings.
Auth owns identities and sessions; Users owns the product profile. App combines their APIs into
the user interface.

[`createModule()`](src/index.ts) returns `publicFetch`, which serves the built SPA.
Browser clients in [`web/src/api.ts`](web/src/api.ts) call `/module/auth/rpc` and
`/module/users/rpc`, typed through `@template/contracts`.

## Navigation and sessions

The dashboard and settings wait for Auth to resolve the session before rendering. Anonymous
visitors go to sign-in; registration, recovery and email confirmation routes remain accessible.
The modules serving protected API calls check the session on every request.

After signing in, the browser returns to the requested App page. [`safeReturnPath`](web/src/return-path.ts)
restricts that destination to product routes under `/app/` to prevent open redirects and login loops.
Login and registration use a full navigation so the next page reads the new session.
Signing out calls Auth's logout procedure before returning to sign-in.

Recovery confirms submission after the server accepts it; connection errors leave the form available for retry.

Settings updates the display name through Users and the email, password and sessions through Auth.
Routes are registered in [`web/src/main.tsx`](web/src/main.tsx).

For the App Vite server, run `pnpm --filter @template/app dev:web`. Use the
[development instructions](../../docs/development.md) to run the complete application.
