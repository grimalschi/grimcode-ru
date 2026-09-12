# Web

One frontend module for public pages and the product interface. A single TanStack Start build
owns the router, components, styles and asset directory. Web uses Auth's HTTP API for identities
and sessions and Users' HTTP API for product profiles.

## Routes and rendering

[`src/routes/__root.tsx`](src/routes/__root.tsx) supplies the document, metadata, favicon and shared
stylesheet. The pathless [`_site` layout](src/routes/_site.tsx) provides public navigation and a
footer for `/`, `/about`, `/contact`, `/legal/terms` and `/legal/privacy`. These pages use SSR:
visitors and crawlers receive their complete HTML before JavaScript runs.

The [`/app` layout](src/routes/app.tsx) disables SSR for its branch through TanStack Start's
[selective SSR](https://tanstack.com/start/latest/docs/framework/react/guide/selective-ssr).
The server returns the document and loading placeholder; product screens render in the browser.
Its session provider, theme provider and notifications stay inside this branch. Routes include
sign-in, registration, recovery, password reset, email verification, email-change confirmation,
the dashboard at `/app/` and account settings at `/app/settings`. Unknown routes return HTTP 404.

All links use their full paths in the shared router, including the `/app` prefix for product pages.
The dashboard and settings wait for Auth to resolve the session before rendering. Anonymous
visitors go to sign-in; registration, recovery and confirmation remain accessible. Protected API
procedures independently check the session on every request.

After sign-in, [`safeReturnPath`](src/return-path.ts) restricts the destination to product routes
under `/app/`, preventing open redirects and login loops. Login and registration use a full
navigation to read the new session. Logout calls Auth before returning to sign-in. Recovery only
confirms submission after the server accepts it; connection errors leave the form available.
Settings updates the display name through Users and email, password and sessions through Auth.
Browser clients in [`src/api.ts`](src/api.ts) call `/module/auth/rpc` and `/module/users/rpc`, typed
through `@template/contracts`.

Public pages use the light palette. The product retains its light/dark/system preference in
`template.app.theme`; the shared document applies it before paint on `/app` requests. Leaving
that branch restores the public palette while keeping the saved product preference.

## HTTP entry and assets

[`createModule({ env: { origin } })`](server/index.mjs) returns `publicFetch` with module id `web`.
Composition supplies `PUBLIC_SITE_URL` as `origin`. [`server/public.mjs`](server/public.mjs) serves
`robots.txt`, `sitemap.xml`, static files and the generated `dist/server/server.js` fetch handler.

Both route branches use `/assets/`. Existing hashed assets are cached for a year; missing paths
inside that reserved directory return a non-HTML 404. Other static files are cached for five minutes.
Product documents use `Cache-Control: no-store` and `X-Robots-Tag: noindex`.
`/app` redirects to `/app/`, preserving its query.
The generated server import disables the import-boundary lint rule only in this adapter so lint
also works before a build; review its imports when changing it.

Replace example content and metadata with the product's own. Fill in the terms and privacy pages
before publication, then remove their `noindex` metadata and add them to `SITEMAP` in
[`server/public.mjs`](server/public.mjs). The initial sitemap lists `/`, `/about` and `/contact`.
Robots excludes `/app/`, `/admin/` and `/module/`.

## Development

Run `pnpm --filter @template/web dev:web` alongside the complete application for hot reload. Vite
uses `PORT + 100` by default (`--port` overrides it) and proxies API requests to the root `.env` PORT.
Use the same hostname for both URLs so cookies work. See the
[development instructions](../../docs/development.md) for worktree setup and the full application.
Only the dev server reads the root `.env`; its `NODE_ENV` cannot change a production build.

`pnpm --filter @template/web build` generates server/client bundles and the route tree. Build before
running this package's `typecheck` or `test`; the root Turbo tasks do this automatically. The module's
HTTP tests exercise the actual built handler, assets and product shell. The
[application tests](../../tests/README.md) cover rendering, navigation and account flows.
